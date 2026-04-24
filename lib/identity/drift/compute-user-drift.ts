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
  // Platform-owned sources (currently only Local Directory) bypass the
  // JML-scope / named-invite "matters to app" rule because every one of
  // their directory users IS by definition a platform-relevant principal.
  const isPlatformOwnedSource = adapter.isPlatformOwnedSource === true;

  // 1. Provider users via adapter
  const providerUsers = await adapter.findAllDirectoryUsers(sourceId, agencyId);

  // 2. JML scope resolution (null means "everyone in scope" for owner sources)
  const scopedEmails: Set<string> | null = isJmlOwner
    ? await adapter.resolveJmlScopeEmails(sourceId, agencyId, jmlScope)
    : new Set();

  // 3. Local users (agency-wide)
  //
  // `is_active=false` on the platform `users` row means the user is
  // admin-disabled in the app. That's a terminal, intentional state: a
  // disabled user is not expected to have a working Keycloak identity or a
  // live GWS/Entra account. Missing/suspended upstream is the desired
  // shape, not drift. We build a `disabledEmails` set here and overlay
  // `status='disabled'` when building UserRow below, uniformly for every
  // adapter (LD/GWS/Entra) without each one needing to know about the
  // `users` table.
  const localUsers = await prisma.users.findMany({
    where: { agency_id: agencyId },
    select: { email: true, is_active: true },
  });
  const localEmails = new Set(
    localUsers.map((u: { email: string }) => u.email.toLowerCase()),
  );
  const disabledEmails = new Set(
    localUsers
      .filter((u: { is_active: boolean | null }) => u.is_active === false)
      .map((u: { email: string }) => u.email.toLowerCase()),
  );

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
    // Platform-owned sources (LD) bypass JML scope entirely — `mattersToApp`
    // is forced true below regardless of scope membership, so the column
    // should render "—" (null) even if a stale `jml_scope` row is present
    // in DB (e.g. from an earlier UI config attempt). Without this guard,
    // a stale empty-groups scope resolves to an empty Set and every LD
    // user gets `inJmlScope: false` → the Users-tab pure-column filter
    // then hides them by default ("7 users outside JML scope" on a source
    // that has no scope concept).
    const inJmlScope: boolean | null = isPlatformOwnedSource || !isJmlOwner
      ? null
      : scopedEmails === null
        ? true
        : scopedEmails.has(emailLc);
    const existsLocally = localEmails.has(emailLc);
    const userInvites = invitesByEmail.get(emailLc) ?? [];
    invitesByEmail.delete(emailLc);

    const namedInviteMatch = userInvites.length > 0;
    const mattersToApp =
      isPlatformOwnedSource ||
      (isJmlOwner && inJmlScope === true) ||
      namedInviteMatch;

    let drift: Drift | null = null;
    if (isJmlOwner && inJmlScope === true && !existsLocally) {
      drift = {
        reason: 'not_in_local_dir',
        details: `${u.email} is in JML scope but not in local directory`,
      };
    }
    // Mirror row indicates the user was not returned by the IdP on last
    // sync (i.e., deleted). Surface this explicitly so the Users tab can
    // distinguish "deleted in IdP" from generic inactivity and operators
    // see it without needing the tooltip.
    //
    // Prefer the tri-state `status` when the adapter populates it; fall
    // back to `!isActive` for legacy adapters.
    //
    // "Deleted" is reported REGARDLESS of `mattersToApp`. A user's
    // absence from the IdP is a fact about the provider, not the app's
    // relationship with that user — an out-of-scope deleted row is still
    // a deleted row, and surfacing that is what lets operators recognise
    // ghost entries in the Users tab even when the JML scope is empty or
    // misconfigured. The UI decides how loudly to render it; here we just
    // don't withhold the classification.
    //
    // Takes priority over `not_in_local_dir` because "deleted" is the more
    // actionable root cause — once the row is deleted, the scope mismatch
    // is a consequence, not the problem to solve.
    const isDeletedInIdp = u.status !== undefined
      ? u.status === 'deleted'
      : !u.isActive;
    if (isDeletedInIdp) {
      drift = {
        reason: 'deleted',
        details: `${u.email} no longer exists in the Identity Source`,
      };
    }

    // App-side overlay: if the platform `users` row is disabled, this
    // user's provider-side state is don't-care. Wipe any drift we just
    // computed — a disabled user missing from Keycloak / GWS / Entra is
    // the intended shape, not drift to remediate. The Users tab reads
    // `status === 'disabled'` to render a neutral "Disabled" pill instead
    // of "In Drift". Takes precedence over `deleted` because once a user
    // is disabled in the app, surfacing them as a red ghost confuses
    // operators (they asked for this outcome).
    const isAppDisabled = disabledEmails.has(emailLc);
    const effectiveStatus: 'active' | 'suspended' | 'deleted' | 'disabled' | undefined =
      isAppDisabled ? 'disabled' : u.status;
    if (isAppDisabled) {
      drift = null;
    }

    return {
      email: u.email,
      displayName: u.displayName,
      department: u.department,
      // `isActive` follows the UI-relevant truth: a disabled user is
      // "not active" even if the IdP still has them enabled.
      isActive: isAppDisabled ? false : u.isActive,
      status: effectiveStatus,
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
