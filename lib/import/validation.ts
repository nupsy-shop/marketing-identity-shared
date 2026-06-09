/**
 * Shared validator for Bulk CSV Import.
 *
 * Single source of truth for:
 *   - Column schema per type (required, optional, example).
 *   - Row-level validation rules (called identically from the browser parser,
 *     the POST route, and the worker — defense in depth, consistent messages).
 *   - Row-count cap.
 *
 * Per docs/features/bulk-csv-import/CLAUDE.md (Gap #6/#7/#9): rules live here,
 * not duplicated in csv-parser.ts, the route, or the worker. Template download
 * reads the same constants so headers cannot drift from validator headers.
 *
 * IMPORTANT: This module must run in both browser and Node. Do NOT import DB,
 * plugins, or server-only modules here. Existence checks (clients, platforms,
 * templates) live in the separate /validate endpoint that calls into this
 * module plus DB lookups.
 */

import type { ImportType, ImportRow, ValidationError } from './types.js';

// ─── Inlined email regex ─────────────────────────────────────────────────────
// Relocated from web `lib/email-validation.ts` so the submodule has no
// `@/lib/...` dependency. Must stay byte-for-byte identical to the web copy so
// browser/server/worker validation agree.

/**
 * Basic full-email validation (external / free-text emails).
 * Not exhaustive — just catches obvious mistakes.
 */
export const FULL_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Types ──────────────────────────────────────────────────────────────────

export type { ImportType, ImportRow, ValidationError } from './types.js';

export const VALID_TYPES: readonly ImportType[] = [
  'clients',
  'access_requests',
  'team_members',
  'template_assignments',
] as const;

export const MAX_ROWS = 500;

export const VALID_APP_ROLES: readonly string[] = [
  'agency_owner',
  'agency_admin',
  'ops_admin',
  'ops_manager',
  'account_manager',
  'viewer',
] as const;

export const VALID_ACCESS_PATTERNS: readonly string[] = [
  'NAMED_INVITE',
  'PARTNER_DELEGATION',
  'GROUP_ACCESS',
  'SHARED_ACCOUNT',
  'PROXY_TOKEN',
] as const;

export const VALID_DURATIONS: readonly string[] = ['permanent', '30', '60', '90'] as const;

export interface TypeSchema {
  required: readonly string[];
  optional: readonly string[];
  example: readonly string[];
  /**
   * Groups of column names where any one member satisfies the requirement for
   * all others in the group. E.g. `[['clientName', 'clientId']]` means a
   * submission that provides `clientId` but omits `clientName` is still valid
   * at the header level — the row-level validator handles the value logic.
   */
  alternativeGroups?: ReadonlyArray<readonly string[]>;
}

/**
 * Colocated schema: one constant per import type with `{ required, optional,
 * example }`. Template download reads `[...required, ...optional]` for the
 * header row and `example` for the sample data row — no drift possible.
 */
export const SCHEMAS: Record<ImportType, TypeSchema> = {
  clients: {
    required: ['name', 'contactEmail'],
    optional: ['contactName', 'website', 'notes'],
    example: ['Acme Corp', 'contact@acme.com', 'Jane Smith', 'https://acme.com', 'Enterprise client'],
  },
  access_requests: {
    required: ['clientName', 'platformKey', 'role'],
    optional: ['clientId', 'accessPattern', 'duration', 'notes'],
    example: ['Acme Corp', 'google-analytics', 'viewer', '', 'NAMED_INVITE', 'permanent', 'Read-only access'],
    // Gap #13: clientId is an acceptable substitute for clientName at the
    // header level. Row-level validation already handles value-level OR logic.
    alternativeGroups: [['clientName', 'clientId']],
  },
  team_members: {
    required: ['email', 'role'],
    optional: ['firstName', 'lastName'],
    example: ['alice@agency.com', 'ops_admin', 'Alice', 'Johnson'],
  },
  template_assignments: {
    required: ['clientName', 'templateKey'],
    optional: ['clientId'],
    example: ['Acme Corp', 'seo-standard', ''],
    // Gap #13: parity with access_requests — clientId satisfies clientName.
    alternativeGroups: [['clientName', 'clientId']],
  },
};

export interface ValidationContext {
  existingClientNames?: Set<string>;
  clientsByName?: Map<string, string>;
  clientsById?: Map<string, string>;
  platformsByKey?: Map<string, { manifest?: { roles?: Array<string | { key?: string; value?: string }> } }>;
  templatesByKey?: Map<string, unknown>;
  currentUserCount?: number;
  maxUsers?: number;
}

export interface RowVerdict {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  /** Action the worker will take when this row is submitted. */
  action: 'create' | 'skip_duplicate' | 'fail';
}

// ─── Public helpers ─────────────────────────────────────────────────────────

export function isKnownType(type: string): type is ImportType {
  return (VALID_TYPES as readonly string[]).includes(type);
}

export function getRequiredHeaders(type: ImportType): readonly string[] {
  return SCHEMAS[type].required;
}

export function getAllHeaders(type: ImportType): readonly string[] {
  return [...SCHEMAS[type].required, ...SCHEMAS[type].optional];
}

export function getExampleRow(type: ImportType): readonly string[] {
  return SCHEMAS[type].example;
}

// ─── Header check ───────────────────────────────────────────────────────────

export interface HeaderValidationResult {
  valid: boolean;
  missing: string[];
  error: string | null;
}

export function validateHeaders(type: ImportType | string, headers: string[]): HeaderValidationResult {
  if (!isKnownType(type)) {
    return { valid: false, missing: [], error: `Unknown type: ${type}` };
  }
  const schema = SCHEMAS[type];
  const required = schema.required;
  const alternativeGroups = schema.alternativeGroups ?? [];
  const normalized = headers.map((h) => h.trim().toLowerCase());

  const missing = required.filter((r) => {
    // Fast path: the required field itself is present.
    if (normalized.includes(r.toLowerCase())) return false;
    // Slow path: check whether any member of an alternative group covers it.
    const group = alternativeGroups.find((g) => g.includes(r));
    if (group) {
      // At least one member of the group is present → requirement satisfied.
      return !group.some((alt) => normalized.includes(alt.toLowerCase()));
    }
    return true; // truly missing with no alternative
  });

  return {
    valid: missing.length === 0,
    missing: missing as string[],
    error: missing.length > 0 ? `Missing required columns: ${missing.join(', ')}` : null,
  };
}

// ─── Row count cap ──────────────────────────────────────────────────────────

export interface RowCountResult {
  ok: boolean;
  /** Canonical message — the same wording is used client- and server-side. */
  message: string;
}

export function checkRowCount(actual: number): RowCountResult {
  if (actual > MAX_ROWS) {
    return { ok: false, message: `CSV has ${actual} rows, max is ${MAX_ROWS}` };
  }
  return { ok: true, message: '' };
}

// ─── Row-level validation ───────────────────────────────────────────────────

/**
 * Validate a single row against the type's schema. Returns an empty array when
 * the row is valid. Each message is stable so client + server + worker agree.
 */
export function validateRow(
  type: ImportType,
  row: ImportRow,
  ctx: ValidationContext = {},
): string[] {
  switch (type) {
    case 'clients':
      return validateClientRow(row, ctx);
    case 'access_requests':
      return validateAccessRequestRow(row, ctx);
    case 'team_members':
      return validateTeamMemberRow(row, ctx);
    case 'template_assignments':
      return validateTemplateAssignmentRow(row, ctx);
    default:
      return [`Unknown import type: ${type}`];
  }
}

/**
 * Run validation over a whole submission and return `ValidationError[]` keyed
 * by 1-indexed row number. The POST route uses this before enqueueing; the
 * worker uses it for defense in depth.
 */
export function validateSubmission(
  type: ImportType,
  rows: ImportRow[],
  ctx: ValidationContext = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = row._rowIndex ?? i + 1;
    const messages = validateRow(type, row, ctx);
    for (const message of messages) {
      errors.push({ row: rowNumber, field: fieldFromMessage(message), message });
    }
  }
  return errors;
}

/**
 * Per-row verdict with the action the worker will take. Used by the
 * /validate endpoint for preview existence-check feedback.
 */
export function buildRowVerdicts(
  type: ImportType,
  rows: ImportRow[],
  ctx: ValidationContext = {},
): RowVerdict[] {
  return rows.map((row, i) => {
    const rowNumber = row._rowIndex ?? i + 1;
    const errors = validateRow(type, row, ctx);
    const duplicate = isClientDuplicate(type, row, ctx);
    if (duplicate) {
      return {
        rowNumber,
        valid: false,
        errors: [...errors, `Client "${(row.name as string) || ''}" already exists (will be skipped)`],
        action: 'skip_duplicate',
      };
    }
    return {
      rowNumber,
      valid: errors.length === 0,
      errors,
      action: errors.length === 0 ? 'create' : 'fail',
    };
  });
}

// ─── Per-type validators ────────────────────────────────────────────────────

function validateClientRow(row: ImportRow, _ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const name = String(row.name || '').trim();
  const contactEmail = String(row.contactEmail || '').trim();

  if (!name) {
    errors.push('name is required');
  }
  if (!contactEmail) {
    errors.push('contactEmail is required');
  } else if (!FULL_EMAIL_REGEX.test(contactEmail)) {
    errors.push('contactEmail is not a valid email');
  }
  return errors;
}

function isClientDuplicate(
  type: ImportType,
  row: ImportRow,
  ctx: ValidationContext,
): boolean {
  if (type !== 'clients') return false;
  const name = String(row.name || '').trim().toLowerCase();
  if (!name) return false;
  return !!ctx.existingClientNames?.has(name);
}

function validateAccessRequestRow(row: ImportRow, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const clientKey = String(row.clientName || row.clientId || '').trim();
  const platformKey = String(row.platformKey || '').trim();
  const role = String(row.role || '').trim();
  const accessPattern = String(row.accessPattern || '').trim();
  const duration = String(row.duration || '').trim();

  if (!clientKey) {
    errors.push('clientName or clientId is required');
  } else if (ctx.clientsByName || ctx.clientsById) {
    const found =
      ctx.clientsByName?.get(clientKey.toLowerCase()) ||
      ctx.clientsById?.get(clientKey);
    if (!found) errors.push(`client_not_found: ${clientKey}`);
  }

  if (!platformKey) {
    errors.push('platformKey is required');
  } else if (ctx.platformsByKey && !ctx.platformsByKey.has(platformKey)) {
    errors.push(`platform_not_found: ${platformKey}`);
  }

  if (!role) {
    errors.push('role is required');
  } else if (platformKey && ctx.platformsByKey?.has(platformKey)) {
    const platform = ctx.platformsByKey.get(platformKey);
    const validRoles = (platform?.manifest?.roles || []).map((r) => {
      if (typeof r === 'string') return r;
      return r.key || r.value || '';
    }).filter(Boolean);
    if (validRoles.length > 0 && !validRoles.includes(role)) {
      errors.push(`Role "${role}" is not valid for platform "${platformKey}". Valid: ${validRoles.join(', ')}`);
    }
  }

  if (accessPattern && !VALID_ACCESS_PATTERNS.includes(accessPattern)) {
    errors.push(`Invalid accessPattern "${accessPattern}". Valid: ${VALID_ACCESS_PATTERNS.join(', ')}`);
  }

  if (duration) {
    if (!VALID_DURATIONS.includes(duration) && isNaN(Date.parse(duration))) {
      errors.push(`Invalid duration "${duration}". Use: permanent, 30, 60, 90, or ISO date`);
    }
  }

  return errors;
}

function validateTeamMemberRow(row: ImportRow, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const email = String(row.email || '').trim();
  const role = String(row.role || '').trim();

  if (!email) {
    errors.push('email is required');
  } else if (!FULL_EMAIL_REGEX.test(email)) {
    errors.push('invalid_email: email is not a valid email');
  }

  if (!role) {
    errors.push('role is required');
  } else if (!VALID_APP_ROLES.includes(role)) {
    errors.push(`Invalid role "${role}". Valid: ${VALID_APP_ROLES.join(', ')}`);
  }

  if (ctx.maxUsers !== undefined && ctx.maxUsers !== Infinity) {
    if ((ctx.currentUserCount || 0) >= ctx.maxUsers) {
      errors.push(`User limit reached (${ctx.maxUsers}). Upgrade to add more.`);
    }
  }

  return errors;
}

function validateTemplateAssignmentRow(row: ImportRow, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  // Gap #13: template_assignments now accepts clientId as alternative to clientName.
  const clientKey = String(row.clientName || row.clientId || '').trim();
  const templateKey = String(row.templateKey || '').trim();

  if (!clientKey) {
    errors.push('clientName or clientId is required');
  } else if (ctx.clientsByName || ctx.clientsById) {
    const found =
      ctx.clientsByName?.get(clientKey.toLowerCase()) ||
      ctx.clientsById?.get(clientKey);
    if (!found) errors.push(`client_not_found: ${clientKey}`);
  }

  if (!templateKey) {
    errors.push('templateKey is required');
  } else if (ctx.templatesByKey && !ctx.templatesByKey.has(templateKey)) {
    errors.push(`template_not_found: ${templateKey}`);
  }

  return errors;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fieldFromMessage(message: string): string | null {
  // Cheap heuristic so route responses carry a stable `field` identifier.
  const known = [
    'name',
    'contactEmail',
    'clientName',
    'clientId',
    'platformKey',
    'role',
    'accessPattern',
    'duration',
    'email',
    'templateKey',
  ];
  const lower = message.toLowerCase();
  if (lower.startsWith('client_not_found')) return 'clientName';
  if (lower.startsWith('platform_not_found')) return 'platformKey';
  if (lower.startsWith('template_not_found')) return 'templateKey';
  if (lower.startsWith('invalid_email')) return 'email';
  for (const f of known) {
    const fl = f.toLowerCase();
    if (
      lower.startsWith(`${fl} `) ||
      lower.includes(`${fl}:`) ||
      lower.includes(`invalid ${fl}`) ||
      lower.includes(`"${fl}"`) // "role" "..."
    ) {
      return f;
    }
  }
  return null;
}
