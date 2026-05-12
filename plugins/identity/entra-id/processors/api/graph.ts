/**
 * Microsoft Graph API — Shared Submodule Helpers
 *
 * Minimal Graph API helpers for Entra ID Bull worker processors.
 * No @/ aliases — plain ESM with .js extensions.
 */

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
 * PATCH /users/{userId} — update user properties.
 */
export async function updateUser(
  accessToken: string,
  userId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(userId)}`, {
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
): Promise<void> {
  const res = await fetch(
    `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/$ref`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        '@odata.id': `${GRAPH_BASE}/directoryObjects/${encodeURIComponent(userId)}`,
      }),
    },
  );
  if (!res.ok) await handleGraphError(res);
}

/**
 * DELETE /groups/{groupId}/members/{userId}/$ref — remove user from group.
 */
export async function removeMember(
  accessToken: string,
  groupId: string,
  userId: string,
): Promise<void> {
  const res = await fetch(
    `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!res.ok) await handleGraphError(res);
}

export interface CreateEntraUserPayload {
  userPrincipalName: string;
  displayName: string;
  mailNickname: string;
  accountEnabled: boolean;
  /**
   * Source-anchor for federated users (Graph requirement).
   *
   * Microsoft requires `onPremisesImmutableId` on POST /users whenever the
   * UPN's domain is configured as federated in the tenant — without it the
   * create fails with `Request_BadRequest` ("ImmutableId is required ..."),
   * which is exactly the failure mode that hit synthetic identities created
   * under an `access.<agency>` federated domain.
   *
   * For non-federated domains Graph accepts (and ignores) the field, so we
   * always set it from the local `integration_identities.id` (a stable UUID)
   * rather than branching on tenant config.
   */
  onPremisesImmutableId?: string;
  passwordProfile: {
    password: string;
    forceChangePasswordNextSignIn: boolean;
  };
}

export interface CreatedEntraUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
}

/**
 * POST /users — create a new Entra ID user.
 *
 * Returns the created user object (Graph returns the user directly with no
 * `.value` wrapper on a POST /users response).
 *
 * Requires User.ReadWrite.All scope on the access token.
 */
export async function createUser(
  accessToken: string,
  payload: CreateEntraUserPayload,
): Promise<CreatedEntraUser> {
  const res = await fetch(`${GRAPH_BASE}/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await handleGraphError(res);
  return res.json() as Promise<CreatedEntraUser>;
}
