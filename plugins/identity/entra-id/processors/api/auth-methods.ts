/**
 * Microsoft Graph — Authentication Method Classification
 *
 * Classifies a user's authentication methods into "strong" (MFA enrolled)
 * or "weak/none" for the Missing-MFA KPI. Also provides chunking helpers
 * and Graph $batch request builder/parser for the per-user fan-out.
 *
 * No @/ aliases — plain ESM with .js extensions.
 */

// ---------------------------------------------------------------------------
// Strong-method classification
// ---------------------------------------------------------------------------

/**
 * Authentication method @odata.type values that unconditionally count as
 * "strong" (i.e., enrolled=true), regardless of other fields.
 *
 * phoneAuthenticationMethod is intentionally omitted here because its
 * strength depends on the `phoneType` field (mobile/alternateMobile = strong,
 * office = not strong). The classifier handles that case separately.
 */
export const STRONG_METHOD_TYPES = [
  '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod',
  '#microsoft.graph.fido2AuthenticationMethod',
  '#microsoft.graph.windowsHelloForBusinessAuthenticationMethod',
  '#microsoft.graph.softwareOathAuthenticationMethod',
  '#microsoft.graph.temporaryAccessPassAuthenticationMethod',
] as const;

const STRONG_METHOD_SET = new Set<string>(STRONG_METHOD_TYPES);
const STRONG_PHONE_TYPES = new Set(['mobile', 'alternateMobile']);

export interface AuthMethod {
  '@odata.type': string;
  phoneType?: string;
  [k: string]: unknown;
}

export interface MfaClassification {
  enrolled: boolean;
  /** The @odata.type strings of all methods on the user (strong and weak). */
  methods: string[];
}

/**
 * Classify a list of authentication methods into enrolled/not-enrolled.
 *
 * A user is considered enrolled if at least one of their methods is:
 *   - Any of the STRONG_METHOD_TYPES above, OR
 *   - phoneAuthenticationMethod with phoneType in {mobile, alternateMobile}.
 *
 * Weak/none: passwordAuthenticationMethod, emailAuthenticationMethod,
 * phoneAuthenticationMethod with phoneType='office', or an empty list.
 */
export function classifyMethods(methods: AuthMethod[]): MfaClassification {
  const detected = methods.map((m) => m['@odata.type']);
  const enrolled = methods.some((m) => {
    if (STRONG_METHOD_SET.has(m['@odata.type'])) return true;
    if (m['@odata.type'] === '#microsoft.graph.phoneAuthenticationMethod') {
      return typeof m.phoneType === 'string' && STRONG_PHONE_TYPES.has(m.phoneType);
    }
    return false;
  });
  return { enrolled, methods: detected };
}

// ---------------------------------------------------------------------------
// chunkBatch — splits an array into chunks of at most `size` elements
// ---------------------------------------------------------------------------

export function chunkBatch<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunkBatch size must be positive, got ${size}`);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[]);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// buildBatchRequest — Graph $batch payload builder
// ---------------------------------------------------------------------------

export interface BatchRequest {
  requests: Array<{ id: string; method: 'GET'; url: string }>;
}

/**
 * Build a Graph $batch request body that fetches /authentication/methods
 * for each userId in the list.
 *
 * Graph $batch limit is 20 requests per call; callers must chunk first with
 * chunkBatch(userIds, 20).
 */
export function buildBatchRequest(userIds: readonly string[]): BatchRequest {
  return {
    requests: userIds.map((id) => ({
      id,
      method: 'GET' as const,
      url: `/users/${id}/authentication/methods`,
    })),
  };
}

// ---------------------------------------------------------------------------
// parseBatchResponse — Graph $batch response parser
// ---------------------------------------------------------------------------

export interface BatchInnerResponse {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: { value?: AuthMethod[]; error?: unknown };
}

export interface BatchResponse {
  responses: BatchInnerResponse[];
}

export interface ParsedBatch {
  /** Successfully classified users. */
  classifications: Map<string, MfaClassification>;
  /** User IDs that returned 403 — consent is missing for this scope. */
  consentMissingFor: string[];
  /** User IDs that returned 429 — should be retried with back-off. */
  throttledFor: string[];
  /** User IDs that returned other non-200 statuses. */
  errorFor: Array<{ userId: string; status: number }>;
}

/**
 * Parse a Graph $batch response into classified results, consent-missing,
 * throttled, and error buckets. Callers handle retry/skip logic.
 */
export function parseBatchResponse(resp: BatchResponse): ParsedBatch {
  const out: ParsedBatch = {
    classifications: new Map(),
    consentMissingFor: [],
    throttledFor: [],
    errorFor: [],
  };

  for (const r of resp.responses) {
    if (r.status === 200) {
      const methods = (r.body?.value ?? []) as AuthMethod[];
      out.classifications.set(r.id, classifyMethods(methods));
    } else if (r.status === 403) {
      out.consentMissingFor.push(r.id);
    } else if (r.status === 429) {
      out.throttledFor.push(r.id);
    } else {
      out.errorFor.push({ userId: r.id, status: r.status });
    }
  }

  return out;
}
