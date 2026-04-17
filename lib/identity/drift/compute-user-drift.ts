/**
 * Compute user-level drift for an identity source.
 *
 * Shared authority for "how does an identity source's directory compare to
 * the app's local state?" Consumed by:
 *   - The Users tab API (`/api/identity/sources/[id]/users`) in the web app.
 *   - JML detect-lifecycle in the Bull worker.
 *
 * The adapter (`IdentityDriftAdapter`) is the ONLY source of truth for
 * provider-side state (directory users, scope resolution, federation
 * orphans). This resolver joins adapter output with local cross-cutting
 * data (users table, named invites) and classifies drift per the
 * `DriftReason` taxonomy.
 *
 * Users-tab semantics:
 *
 *   JML-owner IdP (this source's jml_scope is non-null):
 *     in JML scope AND local       → mattersToApp: true,  drift: null
 *     in JML scope AND not local   → mattersToApp: true,  drift: not_in_local_dir
 *     not in JML scope + no invite → mattersToApp: false, drift: null (Out of Scope)
 *
 *   Non-owner IdP (this source's jml_scope is null):
 *     named-invite target          → mattersToApp: true,  drift: null
 *     anyone else                  → mattersToApp: false, drift: null (Out of Scope)
 *
 * Users whose email appears in NO connected IdP but has an open named
 * invite are emitted as synthetic rows with reason `named_invite_unresolvable`.
 */

import { getRuntime } from '../../runtime.js';
import { getDriftAdapter } from '../../../plugins/identity/drift-adapter-registry.js';
import type { UserRow, NamedInviteDrift, Drift, JmlScopeShape } from './types.js';

export async function computeUserDrift(
  sourceId: string,
  agencyId: string,
): Promise<UserRow[]> {
  const { prisma } = getRuntime();

  const source = await prisma.identity_sources.findFirst({
    where: { id: sourceId, agency_id: agencyId },
    select: { plugin_key: true, jml_scope: true },
  });
  if (!source) return [];

  const adapter = getDriftAdapter(source.plugin_key);
  const jmlScope = (source.jml_scope as JmlScopeShape) ?? null;
  const isJmlOwner = jmlScope !== null;

  // 1. Provider users via adapter
  const providerUsers = await adapter.findAllDirectoryUsers(sourceId, agencyId);

  // 2. JML scope resolution (null means "everyone in scope" for owner sources)
  const scopedEmails: Set<string> | null = isJmlOwner
    ? await adapter.resolveJmlScopeEmails(sourceId, agencyId, jmlScope)
    : new Set();

  // 3. Local users (agency-wide)
  const localUsers = await prisma.users.findMany({
    where: { agency_id: agencyId },
    select: { email: true },
  });
  const localEmails = new Set(localUsers.map((u: { email: string }) => u.email.toLowerCase()));

  // 4. Open named invites
  const namedInvites = await prisma.access_request_items.findMany({
    where: {
      agency_id: agencyId,
      itemType: 'NAMED_INVITE',
      status: { in: ['pending', 'approved', 'provisioned'] },
    },
    select: {
      id: true,
      status: true,
      resolvedIdentity: true,
      agencyGroupEmail: true,
      access_requests: {
        select: { id: true, clientId: true, clients: { select: { name: true } } },
      },
    },
  });

  // 5. Build "exists in any IdP" set for named-invite resolution
  const allSources = await prisma.identity_sources.findMany({
    where: { agency_id: agencyId },
    select: { id: true, plugin_key: true },
  });
  const allIdpEmails = new Set<string>(
    providerUsers.map((u) => u.email.toLowerCase()),
  );
  const otherSources = allSources.filter(
    (s: { id: string }) => s.id !== sourceId,
  );

  for (const other of otherSources) {
    let otherAdapter;
    try {
      otherAdapter = getDriftAdapter(other.plugin_key);
    } catch {
      continue;
    }
    const otherUsers = await otherAdapter.findAllDirectoryUsers(
      other.id,
      agencyId,
    );
    otherUsers.forEach((u) => allIdpEmails.add(u.email.toLowerCase()));
  }

  // 6. Group invites by target email
  const invitesByEmail = new Map<string, NamedInviteDrift[]>();
  for (const inv of namedInvites) {
    const targetEmail = inv.resolvedIdentity ?? inv.agencyGroupEmail;
    if (!targetEmail) continue;
    const key = targetEmail.toLowerCase();
    const drift: NamedInviteDrift = {
      requestItemId: inv.id,
      requestId: inv.access_requests?.id ?? '',
      clientId: inv.access_requests?.clientId ?? '',
      clientName: inv.access_requests?.clients?.name ?? '',
      targetEmail,
      status: inv.status,
    };
    if (!invitesByEmail.has(key)) invitesByEmail.set(key, []);
    invitesByEmail.get(key)!.push(drift);
  }

  // 7. Provider-user rows
  const rows: UserRow[] = providerUsers.map((u) => {
    const emailLc = u.email.toLowerCase();
    const inJmlScope: boolean | null = !isJmlOwner
      ? null
      : scopedEmails === null
        ? true
        : scopedEmails.has(emailLc);
    const existsLocally = localEmails.has(emailLc);
    const userInvites = invitesByEmail.get(emailLc) ?? [];
    invitesByEmail.delete(emailLc);

    const namedInviteMatch = userInvites.length > 0;
    const mattersToApp = (isJmlOwner && inJmlScope === true) || namedInviteMatch;

    let drift: Drift | null = null;
    if (isJmlOwner && inJmlScope === true && !existsLocally) {
      drift = {
        reason: 'not_in_local_dir',
        details: `${u.email} is in JML scope but not in local directory`,
      };
    }

    return {
      email: u.email,
      displayName: u.displayName,
      department: u.department,
      isActive: u.isActive,
      inJmlScope,
      existsLocally,
      namedInvites: userInvites,
      drift,
      mattersToApp,
    };
  });

  // 8. Synthetic rows for invites not matching any IdP user
  const syntheticInJmlScope: boolean | null = isJmlOwner ? false : null;
  for (const [emailLc, invites] of invitesByEmail.entries()) {
    if (!allIdpEmails.has(emailLc)) {
      rows.push({
        email: invites[0].targetEmail,
        displayName: invites[0].targetEmail,
        department: null,
        isActive: false,
        inJmlScope: syntheticInJmlScope,
        existsLocally: false,
        namedInvites: invites,
        drift: {
          reason: 'named_invite_unresolvable',
          details: `Named invite target ${invites[0].targetEmail} does not exist in any connected IdP`,
        },
        mattersToApp: true,
      });
    }
  }

  return rows;
}
