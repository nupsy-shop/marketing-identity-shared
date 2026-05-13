/**
 * IdP teardown for an integration identity — consolidated helper
 * (marketing-identity#1049, follow-up to #1044 / shared#79).
 *
 * Previously this lived twice:
 *   - `marketing-identity/lib/identity/teardown.ts` (web DELETE route)
 *   - inlined into `shared/plugins/identity/local-directory/processors/
 *      iam-teardown-identity.ts` (bull worker)
 *
 * Both copies had identical 3-step logic; they only differed in how they
 * obtained `prisma` + `logger`. This module hosts the canonical
 * implementation and exposes a runtime-injectable surface so both
 * consumers wire in their own prisma + logger without importing concrete
 * app singletons (which the worker doesn't have).
 *
 * Behaviour (UNCHANGED from the two original copies):
 *   1. If `keycloak_user_id` is null → NoOp success (nothing upstream).
 *   2. If the agency has no `agency_settings.keycloak_realm` →
 *      NoOp success (no realm to address the user in).
 *   3. Otherwise call `deleteKeycloakUser(realm, keycloak_user_id)`.
 *      A 404 (defensive — the shared admin client already absorbs it
 *      internally) is treated as success; anything else re-throws with
 *      a payload-safe message for inclusion in an audit event.
 *
 * Agency scoping: the helper reads `agency_settings` filtered by
 * `agency_id`. Consumers are free to layer additional tenant context
 * (web uses `withTenantContext`, the worker uses WHERE-clause filtering)
 * — the helper itself is agency-scope-friendly because it never widens.
 *
 * Idempotency contract is intentionally preserved verbatim — see #1049
 * acceptance ("No new behavior — purely a refactor").
 */

import { deleteKeycloakUser } from '../keycloakAdmin.js';

export interface TeardownableIdentity {
  id: string;
  agency_id: string;
  keycloak_user_id: string | null;
}

/**
 * Minimal structural type covering the Prisma surface this helper needs.
 * Both repos' generated `PrismaClient` satisfy it; defining it
 * structurally avoids importing a concrete `@prisma/client` and keeps the
 * module portable across the web + worker boundary.
 */
export interface PrismaClientLike {
  agency_settings: {
    findFirst(args: {
      where: { agency_id: string };
      select: { keycloak_realm: true };
    }): Promise<{ keycloak_realm: string | null } | null>;
  };
}

type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export interface TeardownLogger {
  debug: LogFn;
  warn: LogFn;
  error: LogFn;
}

export interface TeardownRuntime {
  prisma: PrismaClientLike;
  logger: TeardownLogger;
}

/**
 * Tear down the upstream IdP state for an identity. Resolves on success
 * (including the "nothing to tear down" branches) and throws on failure
 * with a message safe for inclusion in an audit-event payload.
 */
export async function teardownIdpForIdentity(
  identity: TeardownableIdentity,
  runtime: TeardownRuntime,
): Promise<void> {
  const { prisma, logger } = runtime;

  if (!identity.keycloak_user_id) {
    logger.debug('[teardown] no keycloak_user_id — skipping IdP teardown', {
      identityId: identity.id,
    });
    return;
  }

  // Realm name lives on agency_settings (one row per agency). Required
  // to address the user in Keycloak's admin API. If the agency has no
  // realm yet, there is nothing upstream to tear down.
  const settings = await prisma.agency_settings.findFirst({
    where: { agency_id: identity.agency_id },
    select: { keycloak_realm: true },
  });
  const realm = settings?.keycloak_realm;
  if (!realm) {
    logger.debug('[teardown] agency has no keycloak_realm — skipping IdP teardown', {
      identityId: identity.id,
      agencyId: identity.agency_id,
    });
    return;
  }

  try {
    await deleteKeycloakUser(realm, identity.keycloak_user_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Idempotency: a 404 means the upstream user is already gone — treat
    // as success. (The shared `deleteKeycloakUser` already swallows 404
    // internally; this branch remains as defence-in-depth for the case
    // where the underlying admin client surfaces the status in the
    // error message instead.)
    if (/\b404\b/.test(message) || /not\s*found/i.test(message)) {
      logger.warn('[teardown] keycloak user already gone — treating as success', {
        identityId: identity.id,
        keycloakUserId: identity.keycloak_user_id,
      });
      return;
    }
    // Re-throw with a stable, payload-safe message. The route handler /
    // bull processor catches and records this in an audit event.
    throw new Error(`Keycloak user delete failed: ${message}`);
  }
}
