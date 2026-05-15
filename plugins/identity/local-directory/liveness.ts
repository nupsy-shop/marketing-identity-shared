/**
 * Local Directory — liveness probe.
 *
 * Local Directory is a write-managed source: there is no upstream
 * provider to "sync" from. Its liveness signal is whether the agency's
 * Keycloak realm — where local users are mirrored on write — is
 * reachable and exists.
 *
 * Steps:
 *   1. Resolve `agency_settings.keycloak_realm` for the source's agency.
 *   2. Fetch the realm representation via the Keycloak Admin API.
 *
 * Result mapping:
 *   - realm not configured / status != 'active'      → auth (needs_reauth)
 *   - realm 404                                       → auth (needs_reauth)
 *   - 401 / 403 from Keycloak                         → auth (needs_reauth)
 *   - Keycloak admin not configured (env)             → auth (needs_reauth)
 *   - 5xx                                             → server (error)
 *   - network / timeout                               → network (error)
 *   - 2xx                                             → ok
 *
 * Invariants:
 *   - Read-only: never mutates Keycloak or the agency_settings row.
 *   - Bounded: 10s timeout per outbound call.
 *   - No tokens / secrets logged.
 */

import type { LivenessResult } from '../../../lib/platform-health/types.js';
import { getRuntime } from '../../../lib/runtime.js';
import { adminFetch, isKeycloakAdminConfigured } from '../../../lib/keycloakAdmin.js';

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

export async function checkLocalDirectory(
  source: SourceForLiveness,
): Promise<LivenessResult> {
  if (!isKeycloakAdminConfigured()) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'keycloak_admin_not_configured',
    };
  }

  const { prisma } = getRuntime();

  let settings: { keycloak_realm: string | null; keycloak_realm_status: string | null } | null;
  try {
    settings = await prisma.agency_settings.findUnique({
      where: { agency_id: source.agencyId },
      select: { keycloak_realm: true, keycloak_realm_status: true },
    });
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'unknown',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const realm = settings?.keycloak_realm;
  if (!realm) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'realm_not_provisioned',
    };
  }
  if (settings?.keycloak_realm_status && settings.keycloak_realm_status !== 'active') {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: `realm_status_${settings.keycloak_realm_status}`,
    };
  }

  const start = Date.now();
  try {
    const res = await adminFetch(
      realm,
      '',
      { method: 'GET', signal: AbortSignal.timeout(10_000) },
      source.agencyId,
    );
    const latencyMs = Date.now() - start;

    if (res.ok) {
      await res.json().catch(() => ({}));
      return { ok: true, latencyMs };
    }

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return {
        ok: false,
        latencyMs,
        errorCategory: 'auth',
        errorMessage: `HTTP ${res.status}`,
      };
    }
    return {
      ok: false,
      latencyMs,
      errorCategory: res.status >= 500 ? 'server' : 'unknown',
      errorMessage: `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      errorCategory: 'network',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
