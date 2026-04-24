/**
 * Shared types for the remediation engine and its extracted modules.
 *
 * Extracted from `remediation-engine.ts` as part of issue #91. No behaviour
 * change — types are re-exported from the engine for backwards compatibility
 * with any caller that reached into the engine module for a type.
 */

export type TriggerType =
  | 'drift'
  | 'overProvisioned'
  | 'staleAccess'
  | 'sodViolation'
  | 'expiredAccess'
  | 'failedVerification';

export type RemediationMode = 'manual' | 'semi_automatic' | 'fully_automatic';

export interface RemediationPolicy {
  mode: RemediationMode;
  dryRun?: boolean;
  autoCreateWorkflow?: string;
  gracePeriodHours?: number;
  excludePlatforms?: string[];
  excludeUsers?: string[];
}

/** Alias preserved for spec terminology (`PolicyShape`). */
export type PolicyShape = RemediationPolicy;

export interface RemediationPolicies {
  maxActionsPerHour?: number;
  [key: string]: RemediationPolicy | number | undefined;
}

export interface RemediationContext {
  userId?: string;
  targetUserId?: string;
  userEmail?: string;
  platformKey?: string;
  accessRequestItemIds?: string[];
  [key: string]: unknown;
}

export interface RemediationRecord {
  id: string;
  agency_id: string;
  trigger_type: string;
  mode: string;
  status: string;
  target_user_id: string | null;
  target_platform: string | null;
  context: Record<string, unknown> | null;
  before_state: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  workflow_instance_id: string | null;
  scheduled_at: Date | null;
  executed_at: Date | null;
  reverted_at: Date | null;
  revert_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RemediationResult {
  action: string;
  mode?: string;
  remediationId?: string;
  details?: Record<string, unknown>;
  reason?: string;
  workflowInstanceId?: string;
  result?: Record<string, unknown>;
}

export interface MappedRemediation {
  id: string;
  agencyId: string;
  triggerType: string;
  mode: string;
  status: string;
  targetUserId: string | null;
  targetPlatform: string | null;
  context: Record<string, unknown>;
  beforeState: Record<string, unknown>;
  result: Record<string, unknown>;
  workflowInstanceId: string | null;
  scheduledAt: Date | null;
  executedAt: Date | null;
  revertedAt: Date | null;
  revertDeadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFilters {
  triggerType?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface Entitlements {
  features?: {
    autoRemediation?: boolean;
    autoRemediationFull?: boolean;
  };
}

/** Producer (finder) contract — returns findings to be handed to `evaluateAndRemediate`. */
export interface ProducerFinding {
  context: RemediationContext;
}

export type Finder = (
  agencyId: string,
  policy: RemediationPolicy,
) => Promise<ProducerFinding[]>;

export const VALID_TRIGGER_TYPES: TriggerType[] = [
  'drift',
  'overProvisioned',
  'staleAccess',
  'sodViolation',
  'expiredAccess',
  'failedVerification',
];

export const VALID_MODES: RemediationMode[] = [
  'manual',
  'semi_automatic',
  'fully_automatic',
];

export const DEFAULT_MAX_ACTIONS_PER_HOUR = 10;
export const DEFAULT_REVERT_WINDOW_HOURS = 48;
export const CIRCUIT_BREAKER_THRESHOLD = 3;

export type EvaluationSource = 'scheduler' | 'on_demand';

export interface EvaluationStartResult {
  id: string;
  startedAt: Date;
}

export interface EvaluationRunRow {
  id: string;
  agencyId: string;
  startedAt: Date;
  finishedAt: Date | null;
  triggerCounts: Record<string, unknown>;
  status: string;
  error: string | null;
  source: string;
}
