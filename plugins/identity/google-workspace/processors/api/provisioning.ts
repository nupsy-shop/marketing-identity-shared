/**
 * Google Workspace Provisioning API — Shared Copy
 *
 * Admin SDK calls for creating/updating users and reading org-unit structure.
 * Used by the GWS plugin processor to create synthetic identity users.
 *
 * This is a copy of the web app's provisioning API adapted for the shared
 * submodule context (ESM imports with .js extensions, no @/ aliases).
 */

import { apiFetch } from './directory.js';
import type { GoogleUser } from './directory.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN_API_BASE = 'https://admin.googleapis.com/admin/directory/v1';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GoogleOrgUnit {
  orgUnitId: string;
  name: string;
  orgUnitPath: string;
  parentOrgUnitPath?: string;
  description?: string;
}

export interface CreateUserPayload {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  password?: string;
  orgUnitPath?: string;
  changePasswordAtNextLogin?: boolean;
  recoveryEmail?: string;
  includeInGlobalAddressList?: boolean;
}

export interface EnsureUserResult {
  userId: string;
  primaryEmail: string;
  created: boolean;
  moved: boolean;
  orgUnitPath?: string;
  generatedPassword?: string;
}

// ─── User Operations ───────────────────────────────────────────────────────

export async function createUser(
  accessToken: string,
  payload: CreateUserPayload,
): Promise<GoogleUser> {
  const url = `${ADMIN_API_BASE}/users`;

  const password = payload.password || generateRandomPassword();

  const body: Record<string, unknown> = {
    primaryEmail: payload.primaryEmail,
    name: {
      givenName: payload.givenName || 'PAM',
      familyName: payload.familyName || 'Identity',
    },
    password,
    changePasswordAtNextLogin: payload.changePasswordAtNextLogin ?? true,
    orgUnitPath: payload.orgUnitPath || '/',
    suspended: false,
    includeInGlobalAddressList: payload.includeInGlobalAddressList ?? false,
  };

  if (payload.recoveryEmail) {
    body.recoveryEmail = payload.recoveryEmail;
  }

  return apiFetch<GoogleUser>(url, accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateUser(
  accessToken: string,
  userKey: string,
  patch: {
    orgUnitPath?: string;
    suspended?: boolean;
    name?: { givenName?: string; familyName?: string };
    password?: string;
    changePasswordAtNextLogin?: boolean;
  },
): Promise<GoogleUser> {
  const url = `${ADMIN_API_BASE}/users/${encodeURIComponent(userKey)}`;
  return apiFetch<GoogleUser>(url, accessToken, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// ─── Org Unit Operations ────────────────────────────────────────────────────

export async function getOrgUnit(
  accessToken: string,
  customerId: string,
  orgUnitPath: string,
): Promise<GoogleOrgUnit> {
  const normalizedPath = orgUnitPath.startsWith('/') ? orgUnitPath.slice(1) : orgUnitPath;
  const url = `${ADMIN_API_BASE}/customer/${encodeURIComponent(customerId)}/orgunits/${encodeURIComponent(normalizedPath)}`;
  return apiFetch<GoogleOrgUnit>(url, accessToken);
}

// ─── Composite Helpers ──────────────────────────────────────────────────────

export async function ensureUserInOu(
  accessToken: string,
  params: {
    primaryEmail: string;
    givenName: string;
    familyName: string;
    orgUnitPath: string;
    recoveryEmail?: string;
  },
): Promise<EnsureUserResult> {
  const { primaryEmail, givenName, familyName, orgUnitPath, recoveryEmail } = params;
  let moved = false;

  let user: GoogleUser;
  try {
    const { fetchUser } = await import('./directory.js');
    user = await fetchUser(accessToken, primaryEmail);
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code === 'NOT_FOUND') {
      const password = generateRandomPassword();
      user = await createUser(accessToken, {
        primaryEmail,
        givenName: givenName || 'PAM',
        familyName: familyName || 'Identity',
        orgUnitPath,
        recoveryEmail,
        password,
        changePasswordAtNextLogin: false,
      });

      return {
        userId: user.id,
        primaryEmail: user.primaryEmail,
        created: true,
        moved: false,
        orgUnitPath: user.orgUnitPath,
        generatedPassword: password,
      };
    } else {
      throw err;
    }
  }

  if (user.orgUnitPath !== orgUnitPath) {
    user = await updateUser(accessToken, primaryEmail, { orgUnitPath });
    moved = true;
  }

  return {
    userId: user.id,
    primaryEmail: user.primaryEmail,
    created: false,
    moved,
    orgUnitPath: user.orgUnitPath,
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

export function generateRandomPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join('');
}
