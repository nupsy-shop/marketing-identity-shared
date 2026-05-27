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
 *                     (entra_poll_audit, gws_poll_audit,
 *                     detect_drift, detect_principal_drift,
 *                     maintain_drift_remediations, enforce_retention,
 *                     discover_assets, jml_process_lifecycle)
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
  AUDIT_INDEXING: 'audit-indexing', // ← audit log indexing & ES reconciliation
  AUDIT_SEALING: 'audit-sealing',  // ← audit log sealing, TSA retry, archive snapshots
  AUDIT_FORWARDING: 'audit-forwarding', // ← per-plugin audit-event forwarding to external destinations
  AUDIT_EXPORT: 'audit-export', // ← scheduled CSV/JSON/NDJSON exports (cron + run-now)
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
  // Audit-poll jobs — one per plugin that declares an auditAdapter. Each
  // is owned by its plugin (processor + manifest.auditAdapter.jobName).
  // See docs/superpowers/specs/2026-04-19-plugin-owned-platform-audit-polling-design.md.
  entra_poll_audit:           { queue: QUEUE_NAMES.AUTOMATION },
  gws_poll_audit:             { queue: QUEUE_NAMES.AUTOMATION },
  // issue #101 — per-platform audit polls (plugin-owned processors).
  meta_poll_audit:            { queue: QUEUE_NAMES.AUTOMATION },
  google_ads_poll_audit:      { queue: QUEUE_NAMES.AUTOMATION },
  ga4_poll_audit:             { queue: QUEUE_NAMES.AUTOMATION },
  gtm_poll_audit:             { queue: QUEUE_NAMES.AUTOMATION },
  hubspot_poll_audit:         { queue: QUEUE_NAMES.AUTOMATION },
  salesforce_poll_audit:      { queue: QUEUE_NAMES.AUTOMATION },
  okta_poll_audit:            { queue: QUEUE_NAMES.AUTOMATION },
  onelogin_poll_audit:        { queue: QUEUE_NAMES.AUTOMATION },
  jumpcloud_poll_audit:       { queue: QUEUE_NAMES.AUTOMATION },
  detect_drift:               { queue: QUEUE_NAMES.AUTOMATION },
  detect_principal_drift:     { queue: QUEUE_NAMES.AUTOMATION },
  // issue #31 — drift maintenance cron. Per-agency worker that scans
  // pending drift_findings and routes each through evaluateAndRemediate
  // (the same governance chain the workflow engine uses). B-gate is
  // honoured; gated tenants are skipped + audit-logged. Idempotent.
  maintain_drift_remediations: { queue: QUEUE_NAMES.AUTOMATION },
  // Permission analysis scan — per-agency governance scan. Reuses the risk
  // engine, upserts permission_findings, writes a permission_scans row.
  // Phase 1: enqueued manually by POST /api/agency/permission-analysis/scan.
  run_permission_scan_for_agency: { queue: QUEUE_NAMES.AUTOMATION },
  enforce_retention:          { queue: QUEUE_NAMES.AUTOMATION },
  discover_assets:            { queue: QUEUE_NAMES.AUTOMATION },
  jml_detect_lifecycle:       { queue: QUEUE_NAMES.AUTOMATION },
  jml_process_lifecycle:      { queue: QUEUE_NAMES.AUTOMATION },
  autoremediation_evaluate:   { queue: QUEUE_NAMES.AUTOMATION },
  // HRIS webhook ingest: tenant-scoped. Per-agency partitioning is applied
  // by giving Bull a jobId of `hris-<agency>-<provider>-<ts>` so one
  // misbehaving agency's backlog cannot block another agency's events.
  jml_process_hris_events:    { queue: QUEUE_NAMES.AUTOMATION },
  // Campaign-scoped access (issue #60) — per-agency worker ends all
  // campaign-tagged grants via the existing JML leaver.
  end_campaign_for_agency:    { queue: QUEUE_NAMES.AUTOMATION },
  // issue #62 — client onboarding kit per-client worker.
  // Step machine: attach_platforms → install_templates → create_team →
  // provision_team → notify. Fans out to bulk_provision per team member.
  apply_onboarding_kit_for_client: { queue: QUEUE_NAMES.AUTOMATION },

  // ─── Cron fan-out per-agency workers (Heroku Scheduler retirement) ──
  // issue #49 — hourly pre-expiry notices for time-bound access.
  pre_expiry_notify_for_agency:         { queue: QUEUE_NAMES.AUTOMATION },
  // issue #51 — daily automated credential rotation.
  rotate_credentials_for_agency:        { queue: QUEUE_NAMES.AUTOMATION },
  // issue #55 — daily contractor contract-expiration notices.
  notify_contract_expirations_for_agency: { queue: QUEUE_NAMES.AUTOMATION },
  // issue #56 — every-10-min access-window boundary events.
  notify_window_events_for_agency:      { queue: QUEUE_NAMES.AUTOMATION },
  // issue #57 — quarterly client-branded trust reports (gated to 1st of quarter).
  generate_trust_reports_for_agency:    { queue: QUEUE_NAMES.AUTOMATION },
  // issue #58 — nightly cost-optimization findings refresh.
  refresh_cost_optimization_for_agency: { queue: QUEUE_NAMES.AUTOMATION },
  // issue #59 — hourly access-analytics snapshot warmer.
  refresh_access_analytics_for_agency:  { queue: QUEUE_NAMES.AUTOMATION },
  // issue #63 — monthly partner-hub access review digest.
  partner_access_review_for_agency:     { queue: QUEUE_NAMES.AUTOMATION },

  // ─── Directory Sync (tenant-scoped) ─────────────────────────────────
  entra_sync_directory: { queue: QUEUE_NAMES.DIRECTORY_SYNC },
  gws_sync_directory:   { queue: QUEUE_NAMES.DIRECTORY_SYNC },

  // ─── Provisioning (tenant-scoped user/IdP operations) ───────────────
  iam_provision_identity:    { queue: QUEUE_NAMES.PROVISIONING },
  iam_update_identity:       { queue: QUEUE_NAMES.PROVISIONING },
  // issue #1044 — retry of the IdP teardown (Keycloak user delete +
  // per-plugin disconnect hooks) for a row currently in
  // `status='failed_delete'`. Enqueued by the DELETE route on teardown
  // error and by `POST /api/integration-identities/[id]/retry-delete`
  // when an operator clicks "Retry delete". On success the handler
  // deletes the DB row and emits `IDENTITY_DELETED`; on repeated
  // failure the row stays `failed_delete` and Bull's normal
  // retry/backoff/DLQ applies. Worker handler is idempotent — a NoOp
  // if the row is gone or already back to `status='active'`.
  iam_teardown_identity:     { queue: QUEUE_NAMES.PROVISIONING },
  iam_provision_app_user:    { queue: QUEUE_NAMES.PROVISIONING },
  iam_disable_app_user:      { queue: QUEUE_NAMES.PROVISIONING },
  iam_enable_app_user:       { queue: QUEUE_NAMES.PROVISIONING },
  iam_deprovision_app_user:  { queue: QUEUE_NAMES.PROVISIONING },
  gws_create_user:           { queue: QUEUE_NAMES.PROVISIONING },
  gws_suspend_user:          { queue: QUEUE_NAMES.PROVISIONING },
  // issue #988 — per-plugin connection-state health probe. Replaces the
  // cross-plugin `check_connector_health_for_agency` (deleted). Each
  // probe runs the plugin-specific liveness call, evaluates against the
  // Platform Health enum, and persists the resulting `connection_state`.
  // Routed onto AUTOMATION (was the home of the deleted cross-plugin
  // job) so existing concurrency / queue-tier intent is preserved.
  gws_check_health:          { queue: QUEUE_NAMES.AUTOMATION },
  // Mirror of gws_create_user for Entra ID. Processor at
  // shared/plugins/identity/entra-id/processors/entra-create-user.ts;
  // enqueued by the recreate-synthetic-identity remediation handler.
  // The plugin manifest had it registered but the catalog didn't,
  // so every enqueue failed with "[Jobs] Unknown job type
  // 'entra_create_user'" — fixed here.
  entra_create_user:         { queue: QUEUE_NAMES.PROVISIONING },
  entra_suspend_user:        { queue: QUEUE_NAMES.PROVISIONING },
  // issue #988 — Entra mirror of gws_check_health. See note above.
  entra_check_health:        { queue: QUEUE_NAMES.AUTOMATION },
  // Local Directory mirror — Keycloak admin reachability + per-agency
  // realm existence probe. Same cadence (10 min) and queue tier as
  // the GWS / Entra siblings; on success it also stamps last_sync_at
  // since Local Directory has no upstream sync to clear staleness.
  iam_check_health:          { queue: QUEUE_NAMES.AUTOMATION },
  entra_unsuspend_user:      { queue: QUEUE_NAMES.PROVISIONING },
  entra_add_group_member:    { queue: QUEUE_NAMES.PROVISIONING },
  entra_remove_group_member: { queue: QUEUE_NAMES.PROVISIONING },
  local_group_writeback_dispatch: { queue: QUEUE_NAMES.PROVISIONING },
  gws_add_group_member:           { queue: QUEUE_NAMES.PROVISIONING },
  gws_remove_group_member:        { queue: QUEUE_NAMES.PROVISIONING },
  gws_saml_client_configure:   { queue: QUEUE_NAMES.PROVISIONING },
  entra_saml_client_configure: { queue: QUEUE_NAMES.PROVISIONING },
  gws_disconnect:            { queue: QUEUE_NAMES.PROVISIONING },
  entra_disconnect:          { queue: QUEUE_NAMES.PROVISIONING },
  // issue #51 — per-identity credential rotation. Enqueued by the
  // `rotate_credentials_for_agency` scan, one job per identity due.
  // Web-side handler (KMS/vault + rotation providers) is a follow-up;
  // bull-side registers a logging stub that completes until wired.
  rotate_credential_for_identity: { queue: QUEUE_NAMES.PROVISIONING },

  // issue #41 — client offboarding Phase 2. Each step is idempotent,
  // tagged with `offboardingRunId`, owns its `offboarding_run_steps`
  // row, and emits scoped audits with `cause='client_offboarded'`.
  // Routed onto provisioning because every handler is a tenant-scoped,
  // low-volume, write-heavy operation against the same ResourceServer
  // (the offboarded client). Concurrency=1-per-step is enforced via
  // `jobId = offboarding-${runId}-${step}` so a Bull retry never
  // double-fires the destructive write.
  client_offboard_revoke_access:               { queue: QUEUE_NAMES.PROVISIONING },
  client_offboard_disable_identities:          { queue: QUEUE_NAMES.PROVISIONING },
  client_offboard_unassign_team:               { queue: QUEUE_NAMES.PROVISIONING },
  client_offboard_pause_scim_and_remediation:  { queue: QUEUE_NAMES.PROVISIONING },
  client_offboard_deny_pending_requests:       { queue: QUEUE_NAMES.PROVISIONING },
  client_offboard_finalize:                    { queue: QUEUE_NAMES.PROVISIONING },

  // ─── Notifications (tenant-scoped) ──────────────────────────────────
  webhook_deliver: { queue: QUEUE_NAMES.NOTIFICATIONS },
  email_send:      { queue: QUEUE_NAMES.NOTIFICATIONS },
  slack_notify:    { queue: QUEUE_NAMES.NOTIFICATIONS },

  // ─── Bulk Ops (tenant-scoped, user-initiated) ───────────────────────
  identity_sync:    { queue: QUEUE_NAMES.BULK_OPS },
  bulk_provision:   { queue: QUEUE_NAMES.BULK_OPS },
  // CSV-import flow (POST /api/agency/bulk-import). Distinct from
  // `bulk_provision` because the two handlers have completely different
  // payload shapes — bulk_provision is the Keycloak user provisioner
  // ({tenantId, realm, identityIds, users}), bulk_csv_import is the
  // CSV-row processor ({tenantId, importType, rows, actor}). Sharing the
  // same job_type caused both handlers to race on the same Bull queue:
  // bull's bulk-provision.ts picked CSV-import jobs up, returned
  // 'completed' without writing counts, and the run-bull-job-harness
  // hit a terminal-state row with result=null. See #1405.
  bulk_csv_import:  { queue: QUEUE_NAMES.BULK_OPS },
  bulk_revoke:      { queue: QUEUE_NAMES.BULK_OPS },
  audit_export:     { queue: QUEUE_NAMES.BULK_OPS },

  // ─── System (no tenantId) ───────────────────────────────────────────
  dispatch_poll_audits:       { queue: QUEUE_NAMES.SYSTEM },
  dispatch_detect_drift:              { queue: QUEUE_NAMES.SYSTEM },
  dispatch_detect_principal_drift:    { queue: QUEUE_NAMES.SYSTEM },
  // issue #31 — fan-out for the drift maintenance cron. One
  // maintain_drift_remediations child per active agency.
  dispatch_maintain_drift_remediations: { queue: QUEUE_NAMES.SYSTEM },
  dispatch_enforce_retention:         { queue: QUEUE_NAMES.SYSTEM },
  dispatch_discover_assets:   { queue: QUEUE_NAMES.SYSTEM },
  dispatch_sync_directories:      { queue: QUEUE_NAMES.SYSTEM },
  dispatch_autoremediation_eval:  { queue: QUEUE_NAMES.SYSTEM },
  // Campaign-scoped access (issue #60) — system dispatcher that fans out
  // one end_campaign_for_agency job per due campaign.
  dispatch_end_campaign:          { queue: QUEUE_NAMES.SYSTEM },
  iam_provision_realm:            { queue: QUEUE_NAMES.SYSTEM },
  iam_upsert_realm_idp:           { queue: QUEUE_NAMES.SYSTEM },
  // Agency offboarding — deletes the per-agency Keycloak realm. The processor
  // (shared/lib/identity/sso/iam-delete-realm.ts) reads the realm pointer from
  // server-state (agency_settings.keycloak_realm) and refuses to touch
  // PROTECTED_REALMS (e.g. agency-trevox, master) under any payload.
  iam_delete_realm:               { queue: QUEUE_NAMES.SYSTEM },
  // issue #62 — fan-out dispatcher. Routes an onboarding-kit apply
  // to the per-client automation worker.
  dispatch_apply_onboarding_kit:  { queue: QUEUE_NAMES.SYSTEM },

  // ─── Cron fan-out dispatchers (Heroku Scheduler retirement) ─────────
  // Each fans out one tenant-scoped child per active agency. Cron
  // patterns live in src/index.ts registerDispatchers().
  dispatch_pre_expiry_notifier:          { queue: QUEUE_NAMES.SYSTEM }, // hourly #49
  dispatch_rotate_credentials:           { queue: QUEUE_NAMES.SYSTEM }, // daily 02:00 #51
  dispatch_check_connector_health:       { queue: QUEUE_NAMES.SYSTEM }, // */10 #54
  dispatch_notify_contract_expirations:  { queue: QUEUE_NAMES.SYSTEM }, // daily 07:00 #55
  dispatch_notify_window_events:         { queue: QUEUE_NAMES.SYSTEM }, // */10 #56
  dispatch_generate_trust_reports:       { queue: QUEUE_NAMES.SYSTEM }, // daily 06:00, gated to 1st of quarter #57
  dispatch_refresh_cost_optimization:    { queue: QUEUE_NAMES.SYSTEM }, // daily 03:00 #58
  dispatch_refresh_access_analytics:     { queue: QUEUE_NAMES.SYSTEM }, // hourly #59
  dispatch_partner_access_review:        { queue: QUEUE_NAMES.SYSTEM }, // daily 07:00, gated to 1st of month #63

  // ─── Audit indexing & sealing (system-scoped) ───────────────────────
  audit_index_es:     { queue: QUEUE_NAMES.AUDIT_INDEXING },
  audit_reconcile_es: { queue: QUEUE_NAMES.AUDIT_INDEXING },
  // Sealing is its own queue (not AUDIT_INDEXING) because the sealer is
  // long-running per cycle, single-instance — it must not compete with the
  // high-fan-out indexer workers for Bull concurrency slots.
  audit_seal:               { queue: QUEUE_NAMES.AUDIT_SEALING },
  audit_tsa_retry:          { queue: QUEUE_NAMES.AUDIT_SEALING },
  audit_archive_snapshot:   { queue: QUEUE_NAMES.AUDIT_SEALING },

  // ─── Audit forwarding (per-plugin, fired from publisher.flush) ──────
  // One job type per audit-destination plugin. The publisher's
  // `enqueueForwardJobs` (lib/audit/forward-dispatch.ts) dispatches one
  // job per (batch × enabled destination); the per-plugin processor in
  // shared/plugins/audit-destinations/{key}/processors/ owns the
  // formatBatch + sendBatch call and the stat-row update via
  // lib/audit-destinations/stats.ts.
  //
  // BullMQ retry is intentionally disabled on this queue at the worker
  // layer (attempts: 1) — `recordFailure` owns the retry semantics
  // (5-failure auto-disable). Bull's own retry would double-count.
  webhook_forward_batch:    { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  slack_forward_batch:      { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  datadog_forward_batch:    { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  splunk_forward_batch:     { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  pagerduty_forward_batch:  { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  s3_forward_batch:         { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  syslog_forward_batch:     { queue: QUEUE_NAMES.AUDIT_FORWARDING },
  cef_syslog_forward_batch: { queue: QUEUE_NAMES.AUDIT_FORWARDING },

  // ─── Audit export (scheduled CSV/JSON/NDJSON) ───────────────────────
  // Repeatable per `audit_export_schedules` row (Bull jobId
  // `audit-export:cron:{scheduleId}`) plus on-demand priority jobs from
  // POST /api/agency/audit/exports/[id]/run (Bull jobId
  // `audit-export:manual:{scheduleId}:{ISO}`). Processor owned by the
  // shared `audit-export` plugin (concurrency 3, attempts 1 — failures
  // recorded on the schedule row).
  audit_export_run:         { queue: QUEUE_NAMES.AUDIT_EXPORT },
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
  // Every audit-forward job carries `agencyId` (its destination row is
  // owned by an agency); RLS scope and the tenant-dashboard fan-out
  // counters both want it bucketed per-tenant.
  QUEUE_NAMES.AUDIT_FORWARDING,
  // audit_export_run carries `agencyId` — schedule rows are agency-owned
  // and the processor only reads/writes within that scope.
  QUEUE_NAMES.AUDIT_EXPORT,
]);

export function isTenantScopedQueue(queue: unknown): queue is QueueName {
  return typeof queue === 'string' && TENANT_SCOPED_QUEUES.has(queue as QueueName);
}
