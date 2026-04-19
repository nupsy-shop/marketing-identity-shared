/**
 * Job Catalog — single source of truth for every queued work type.
 *
 * Both the Bull worker (marketing-identity-bull) and the web app
 * (marketing-identity) import from here. The catalog answers:
 *
 *   "What queue consumes this job type?"
 *   "Is this a tenant-scoped job?"
 *
 * Adding a new job type requires exactly one change: adding an entry
 * here. Startup assertions in the worker will catch missing handlers.
 *
 * Queue taxonomy (operator-facing, semantic):
 *
 *   automation      — cron-driven polling and chained automation.
 *                     Tenant-scoped; fans out per agency.
 *                     (entra_poll_audit, gws_poll_audit, detect_drift,
 *                     enforce_retention, discover_assets,
 *                     jml_process_lifecycle)
 *
 *   directory-sync  — directory state reconciliation from upstream IdPs.
 *                     Tenant-scoped; triggered by user or by a
 *                     per-agency schedule.
 *                     (entra_sync_directory, gws_sync_directory)
 *
 *   provisioning    — tenant-scoped user/IdP/app-user lifecycle actions.
 *                     Excludes agency-creation operations, which live
 *                     on the system queue.
 *
 *   notifications   — outbound webhook / email / Slack deliveries.
 *
 *   bulk-ops        — user-initiated batch work (bulk provision/revoke,
 *                     full-agency identity sync).
 *
 *   system          — non-tenant jobs: fan-out dispatchers and
 *                     agency-provisioning (iam_provision_realm).
 *                     No per-tenant middleware (nothing to key on).
 *                     Not surfaced in the tenant dashboard.
 */

export const QUEUE_NAMES = {
  AUTOMATION: 'automation',
  DIRECTORY_SYNC: 'directory-sync',
  PROVISIONING: 'provisioning',
  NOTIFICATIONS: 'notifications',
  BULK_OPS: 'bulk-ops',
  SYSTEM: 'system',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

interface JobDefinition {
  queue: QueueName;
}

/**
 * Every job type in the system. Adding a new job requires:
 *   1. An entry here (declares the queue).
 *   2. A matching handler registered in the worker's queue module or
 *      in a plugin manifest.
 *
 * The worker asserts (1) ⇔ (2) at startup.
 */
export const JOB_CATALOG = {
  // ─── Automation (tenant-scoped) ─────────────────────────────────────
  entra_poll_audit:           { queue: QUEUE_NAMES.AUTOMATION },
  gws_poll_audit:             { queue: QUEUE_NAMES.AUTOMATION },
  detect_drift:               { queue: QUEUE_NAMES.AUTOMATION },
  enforce_retention:          { queue: QUEUE_NAMES.AUTOMATION },
  discover_assets:            { queue: QUEUE_NAMES.AUTOMATION },
  jml_detect_lifecycle:       { queue: QUEUE_NAMES.AUTOMATION },
  jml_process_lifecycle:      { queue: QUEUE_NAMES.AUTOMATION },
  autoremediation_evaluate:   { queue: QUEUE_NAMES.AUTOMATION },
  // HRIS webhook ingest: tenant-scoped. Per-agency partitioning is applied
  // by giving Bull a jobId of `hris-<agency>-<provider>-<ts>` so one
  // misbehaving agency's backlog cannot block another agency's events.
  jml_process_hris_events:    { queue: QUEUE_NAMES.AUTOMATION },

  // ─── Directory Sync (tenant-scoped) ─────────────────────────────────
  entra_sync_directory: { queue: QUEUE_NAMES.DIRECTORY_SYNC },
  gws_sync_directory:   { queue: QUEUE_NAMES.DIRECTORY_SYNC },

  // ─── Provisioning (tenant-scoped user/IdP operations) ───────────────
  iam_provision_identity:    { queue: QUEUE_NAMES.PROVISIONING },
  iam_update_identity:       { queue: QUEUE_NAMES.PROVISIONING },
  iam_provision_app_user:    { queue: QUEUE_NAMES.PROVISIONING },
  iam_disable_app_user:      { queue: QUEUE_NAMES.PROVISIONING },
  iam_enable_app_user:       { queue: QUEUE_NAMES.PROVISIONING },
  iam_deprovision_app_user:  { queue: QUEUE_NAMES.PROVISIONING },
  gws_create_user:           { queue: QUEUE_NAMES.PROVISIONING },
  gws_suspend_user:          { queue: QUEUE_NAMES.PROVISIONING },
  entra_suspend_user:        { queue: QUEUE_NAMES.PROVISIONING },
  entra_unsuspend_user:      { queue: QUEUE_NAMES.PROVISIONING },
  entra_add_group_member:    { queue: QUEUE_NAMES.PROVISIONING },
  entra_remove_group_member: { queue: QUEUE_NAMES.PROVISIONING },
  saml_client_configure:     { queue: QUEUE_NAMES.PROVISIONING },

  // ─── Notifications (tenant-scoped) ──────────────────────────────────
  webhook_deliver: { queue: QUEUE_NAMES.NOTIFICATIONS },
  email_send:      { queue: QUEUE_NAMES.NOTIFICATIONS },
  slack_notify:    { queue: QUEUE_NAMES.NOTIFICATIONS },

  // ─── Bulk Ops (tenant-scoped, user-initiated) ───────────────────────
  identity_sync:  { queue: QUEUE_NAMES.BULK_OPS },
  bulk_provision: { queue: QUEUE_NAMES.BULK_OPS },
  bulk_revoke:    { queue: QUEUE_NAMES.BULK_OPS },

  // ─── System (no tenantId) ───────────────────────────────────────────
  dispatch_poll_audits:       { queue: QUEUE_NAMES.SYSTEM },
  dispatch_detect_drift:      { queue: QUEUE_NAMES.SYSTEM },
  dispatch_enforce_retention: { queue: QUEUE_NAMES.SYSTEM },
  dispatch_discover_assets:   { queue: QUEUE_NAMES.SYSTEM },
  dispatch_sync_directories:      { queue: QUEUE_NAMES.SYSTEM },
  dispatch_autoremediation_eval:  { queue: QUEUE_NAMES.SYSTEM },
  iam_provision_realm:            { queue: QUEUE_NAMES.SYSTEM },
} as const satisfies Record<string, JobDefinition>;

export type JobType = keyof typeof JOB_CATALOG;

/** Typed lookup: returns the queue for a known job type. */
export function queueFor(jobType: JobType): QueueName {
  return JOB_CATALOG[jobType].queue;
}

/** Untyped lookup: returns undefined for job types not in the catalog. */
export function queueForUnsafe(jobType: string): QueueName | undefined {
  return (JOB_CATALOG as Record<string, JobDefinition | undefined>)[jobType]?.queue;
}

/**
 * The set of queues that process tenant-scoped work. Every job on
 * these queues MUST carry a `tenantId` in its payload; jobs without
 * one on these queues are a bug.
 *
 * The system queue is intentionally absent — it holds non-tenant work
 * and does not appear in the tenant dashboard.
 */
export const TENANT_SCOPED_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>([
  QUEUE_NAMES.AUTOMATION,
  QUEUE_NAMES.DIRECTORY_SYNC,
  QUEUE_NAMES.PROVISIONING,
  QUEUE_NAMES.NOTIFICATIONS,
  QUEUE_NAMES.BULK_OPS,
]);

export function isTenantScopedQueue(queue: unknown): queue is QueueName {
  return typeof queue === 'string' && TENANT_SCOPED_QUEUES.has(queue as QueueName);
}
