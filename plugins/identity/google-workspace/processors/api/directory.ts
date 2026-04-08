/**
 * Google Workspace Directory API — Shared Subset
 *
 * Contains only the functions needed by the GWS plugin processors:
 * - apiFetch (retry + error mapping)
 * - fetchUser (single user lookup)
 * - GoogleUser type
 * - IdentityPluginError class
 *
 * The full directory API (listUsers, listGroups, etc.) remains in the
 * web app's plugin directory.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const ADMIN_API_BASE = 'https://admin.googleapis.com/admin/directory/v1';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type IdentityErrorCode =
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'SCOPE_INSUFFICIENT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'CONFLICT';

export class IdentityPluginError extends Error {
  code: IdentityErrorCode;
  statusCode: number;
  retryAfter?: number;

  constructor(message: string, code: IdentityErrorCode, statusCode: number = 500, retryAfter?: number) {
    super(message);
    this.name = 'IdentityPluginError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

export interface GoogleUser {
  id: string;
  primaryEmail: string;
  name: {
    givenName?: string;
    familyName?: string;
    fullName?: string;
  };
  suspended?: boolean;
  archived?: boolean;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  orgUnitPath?: string;
  thumbnailPhotoUrl?: string;
  [key: string]: unknown;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a fetch request with retry logic for rate-limit and transient errors.
 */
export async function apiFetch<T>(
  url: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        const delayMs = retryAfterSeconds ? retryAfterSeconds * 1000 : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

        if (attempt < MAX_RETRIES) {
          await sleep(delayMs);
          continue;
        }

        throw new IdentityPluginError('Google Admin API rate limit exceeded', 'RATE_LIMITED', 429, retryAfterSeconds);
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }

      if (response.status === 401) {
        const body = await response.text();
        throw new IdentityPluginError(`Authentication failed: ${body}`, 'AUTH_ERROR', 401);
      }

      if (response.status === 403) {
        const body = await response.text();
        throw new IdentityPluginError(`Permission denied: ${body}`, 'PERMISSION_DENIED', 403);
      }

      if (response.status === 404) {
        const body = await response.text();
        throw new IdentityPluginError(`Resource not found: ${body}`, 'NOT_FOUND', 404);
      }

      if (response.status === 409) {
        const body = await response.text();
        throw new IdentityPluginError(`Conflict: ${body}`, 'CONFLICT', 409);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new IdentityPluginError(`Google Admin API error (${response.status}): ${body}`, 'PROVIDER_ERROR', response.status);
      }

      const text = await response.text();
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof IdentityPluginError) throw error;
      lastError = error as Error;

      if (attempt < MAX_RETRIES) {
        const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }
    }
  }

  throw new IdentityPluginError(
    `Network error after ${MAX_RETRIES} retries: ${lastError?.message ?? 'unknown'}`,
    'NETWORK_ERROR',
    0,
  );
}

// ─── User Operations ────────────────────────────────────────────────────────

/**
 * Fetch a single user by primary email or user ID.
 */
export async function fetchUser(accessToken: string, userKey: string): Promise<GoogleUser> {
  const url = `${ADMIN_API_BASE}/users/${encodeURIComponent(userKey)}`;
  return apiFetch<GoogleUser>(url, accessToken);
}

/**
 * List users in a domain, scoped to an optional orgUnitPath.
 */
export async function fetchUsers(
  accessToken: string,
  domain: string,
  pageToken?: string,
  maxResults: number = 200,
  query?: string,
): Promise<{ users?: GoogleUser[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ domain, maxResults: String(maxResults) });
  if (pageToken) params.set('pageToken', pageToken);
  if (query) params.set('query', query);
  const url = `${ADMIN_API_BASE}/users?${params.toString()}`;
  return apiFetch<{ users?: GoogleUser[]; nextPageToken?: string }>(url, accessToken);
}

// ─── Group Operations ──────────────────────────────────────────────────────

export interface GoogleGroup {
  id: string;
  email: string;
  name: string;
  description?: string;
  directMembersCount?: string;
  adminCreated?: boolean;
  [key: string]: unknown;
}

export interface GoogleMember {
  id: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'MEMBER';
  type: 'USER' | 'GROUP' | 'CUSTOMER';
  status?: string;
  [key: string]: unknown;
}

/**
 * List groups in a Google Workspace domain.
 */
export async function fetchGroups(
  accessToken: string,
  domain: string,
  pageToken?: string,
  maxResults: number = 200,
): Promise<{ groups?: GoogleGroup[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ domain, maxResults: String(maxResults) });
  if (pageToken) params.set('pageToken', pageToken);
  const url = `${ADMIN_API_BASE}/groups?${params.toString()}`;
  return apiFetch<{ groups?: GoogleGroup[]; nextPageToken?: string }>(url, accessToken);
}

/**
 * List members of a group (paginated).
 */
export async function fetchGroupMembers(
  accessToken: string,
  groupKey: string,
  pageToken?: string,
): Promise<{ members?: GoogleMember[]; nextPageToken?: string }> {
  const params = new URLSearchParams();
  if (pageToken) params.set('pageToken', pageToken);
  const query = params.toString();
  const url = `${ADMIN_API_BASE}/groups/${encodeURIComponent(groupKey)}/members${query ? `?${query}` : ''}`;
  return apiFetch<{ members?: GoogleMember[]; nextPageToken?: string }>(url, accessToken);
}
