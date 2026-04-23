/**
 * Microsoft Graph API — Shared Submodule Helpers
 *
 * Minimal Graph API helpers for Entra ID Bull worker processors.
 * No @/ aliases — plain ESM with .js extensions.
 */

import {
  resolveProviderOverride,
  applyOverrideDelay,
} from '../../../../../lib/http/provider-override-resolver.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function handleGraphError(res: Response): Promise<never> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = 'Unable to read error body';
  }
  throw new Error(`Microsoft Graph error (${res.status}): ${body.slice(0, 300)}`);
}

/**
 * E2E provider-response override hook. When `agencyId` is set and a matching
 * `provider_response_overrides` row exists, the real Graph call is skipped.
 * Forced 4xx/5xx are re-raised as `Error` (same shape as handleGraphError) so
 * callers see identical behavior to a live failure. Fail-closed: null on any
 * resolver error. Non-prod gated.
 */
async function maybeApplyGraphOverride(
  url: string,
  agencyId: string | undefined,
): Promise<boolean> {
  if (!agencyId) return false;
  const override = await resolveProviderOverride(agencyId, 'entra', url);
  if (!override) return false;
  await applyOverrideDelay(override);
  if (override.status >= 400) {
    const bodyStr =
      override.body == null
        ? `forced override ${override.status}`
        : typeof override.body === 'string'
          ? override.body
          : JSON.stringify(override.body);
    throw new Error(
      `Microsoft Graph error (${override.status}): ${bodyStr.slice(0, 300)}`,
    );
  }
  // 2xx override = silent success (these helpers return void).
  return true;
}

/**
 * PATCH /users/{userId} — update user properties.
 */
export async function updateUser(
  accessToken: string,
  userId: string,
  properties: Record<string, unknown>,
  agencyId?: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(userId)}`;
  if (await maybeApplyGraphOverride(url, agencyId)) return;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(properties),
  });
  if (!res.ok) await handleGraphError(res);
}

/**
 * POST /groups/{groupId}/members/$ref — add user to group.
 */
export async function addMember(
  accessToken: string,
  groupId: string,
  userId: string,
  agencyId?: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/$ref`;
  if (await maybeApplyGraphOverride(url, agencyId)) return;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      '@odata.id': `${GRAPH_BASE}/directoryObjects/${encodeURIComponent(userId)}`,
    }),
  });
  if (!res.ok) await handleGraphError(res);
}

/**
 * DELETE /groups/{groupId}/members/{userId}/$ref — remove user from group.
 */
export async function removeMember(
  accessToken: string,
  groupId: string,
  userId: string,
  agencyId?: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`;
  if (await maybeApplyGraphOverride(url, agencyId)) return;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await handleGraphError(res);
}
