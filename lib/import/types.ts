// shared/lib/import/types.ts
// Canonical bulk-import types, moved from web lib/import/bulk-import.ts +
// lib/bulk/validator.ts so both the web app and the bull worker share them.

export type ImportType =
  | 'clients'
  | 'access_requests'
  | 'team_members'
  | 'template_assignments';

export interface ValidationError {
  row: number;
  field: string | null;
  message: string;
  reason?: string;
}

export interface ImportRow {
  _rowIndex?: number;
  name?: string;
  contactEmail?: string;
  contactName?: string;
  website?: string;
  notes?: string;
  clientName?: string;
  clientId?: string;
  platformKey?: string;
  role?: string;
  accessPattern?: string;
  duration?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  templateKey?: string;
  [key: string]: unknown;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: ValidationError[];
}

export interface ImportActor {
  id: string;
  email: string;
  agencyId: string;
  agencySlug?: string;
  [key: string]: unknown;
}
