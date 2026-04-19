/**
 * HRIS Event Processor — Shared Library
 *
 * Invoked by the Bull worker for the `jml_process_hris_events` job type.
 * Consumes a batch of translated HRIS events and:
 *
 *   1. Resolves each event to a `directory_user` by
 *      (agency_id, hr_source, hr_employee_id). No placeholder users are
 *      created — unmatched events produce a `jml.hris.webhook_orphan`
 *      audit record and are skipped.
 *   2. Updates `directory_users.hr_*` fields (best-effort).
 *   3. Builds a provider-agnostic `LifecycleEvents` payload and hands it
 *      to the canonical `lifecycle-processor` using the agency's configured
 *      source-of-truth identity_source row. That processor must NOT import
 *      this module — the dependency goes ONE WAY.
 *
 * All DB access runs inside the Bull worker's `withTenantContext` block.
 * This module deliberately does not import the tenant context helper —
 * the caller is responsible for wrapping.
 */

import type { LifecycleEvents, ProcessLifecycleParams } from './lifecycle-processor.js';
import { processLifecycleEvents } from './lifecycle-processor.js';

// Mirror of `plugins/identity/common/hris-translator.ts` — duplicated here
// so shared/ has no dependency on the web-app plugins/ tree. The shapes
// must stay in sync; a CI contract test can verify if needed.
export interface TranslatedHrisEvent {
  kind: 'joiner' | 'leaver' | 'suspended' | 'unsuspended' | 'mover';
  hrSource: 'bamboohr' | 'workday' | 'adp';
  hrEmployeeId: string;
  providerStatus?: string;
  email?: string | null;
  attribute?: 'department' | 'job_title';
  oldValue?: string | null;
  newValue?: string | null;
  occurredAt?: string;
}

export interface HrisJobPayload {
  tenantId: string;
  agencyId: string;
  provider: 'bamboohr' | 'workday' | 'adp';
  events: TranslatedHrisEvent[];
  triggerSource: string;
}

type AuditEmitter = (params: {
  eventType: string;
  source: string;
  severity: string;
  agency: { id: string };
  context: Record<string, unknown>;
}) => Promise<unknown>;

// ─── Orphan-aware lifecycle translation ───────────────────────────────────

/**
 * Build a `LifecycleEvents` payload from a translated HRIS batch, using
 * caller-provided directory-user resolution. Unmatched events emit an
 * orphan audit event and are excluded from the output.
 */
export async function resolveHrisBatch(params: {
  agencyId: string;
  provider: 'bamboohr' | 'workday' | 'adp';
  triggerSource: string;
  events: TranslatedHrisEvent[];
  /**
   * Resolve a batch of `hrEmployeeId`s to known directory users. Returns
   * only the ones that matched; unmatched IDs are orphans.
   */
  resolveUsers: (
    hrEmployeeIds: string[],
  ) => Promise<Array<{
    hrEmployeeId: string;
    directoryUserId: string;
    externalId: string;
    email: string;
  }>>;
  /**
   * Best-effort update of `directory_users.hr_*` columns. Errors are
   * swallowed by the implementer.
   */
  tagUser: (args: {
    directoryUserId: string;
    hrEmployeeId: string;
    hrStatus: string | null;
  }) => Promise<void>;
  publishAuditEvent: AuditEmitter;
}): Promise<{ matched: number; orphans: number; lifecycle: LifecycleEvents }> {
  const { agencyId, provider, triggerSource, events, resolveUsers, tagUser, publishAuditEvent } = params;

  if (!events || events.length === 0) {
    return { matched: 0, orphans: 0, lifecycle: {} };
  }

  const ids = Array.from(new Set(events.map((e) => e.hrEmployeeId)));
  const resolved = await resolveUsers(ids);
  const byEmployeeId = new Map(resolved.map((r) => [r.hrEmployeeId, r]));

  const lifecycle: LifecycleEvents = {
    joiners: [],
    leavers: [],
    suspended: [],
    unsuspended: [],
    groupChanges: [],
    attributeChanges: [],
  };

  let matched = 0;
  let orphans = 0;

  for (const evt of events) {
    const user = byEmployeeId.get(evt.hrEmployeeId);
    if (!user) {
      orphans++;
      await publishAuditEvent({
        eventType: 'jml.hris.webhook_orphan',
        source: 'hris',
        severity: 'warning',
        agency: { id: agencyId },
        context: {
          provider,
          hr_employee_id: evt.hrEmployeeId,
          email: evt.email ?? null,
          kind: evt.kind,
          trigger_source: triggerSource,
        },
      });
      continue;
    }

    matched++;

    switch (evt.kind) {
      case 'joiner':     lifecycle.joiners!.push(user.externalId); break;
      case 'leaver':     lifecycle.leavers!.push(user.externalId); break;
      case 'suspended':  lifecycle.suspended!.push(user.externalId); break;
      case 'unsuspended': lifecycle.unsuspended!.push(user.externalId); break;
      case 'mover':
        if (evt.attribute) {
          lifecycle.attributeChanges!.push({
            userExternalId: user.externalId,
            userEmail: user.email,
            attribute: evt.attribute,
            oldValue: evt.oldValue ?? null,
            newValue: evt.newValue ?? null,
          });
        }
        break;
    }

    await tagUser({
      directoryUserId: user.directoryUserId,
      hrEmployeeId: evt.hrEmployeeId,
      hrStatus: evt.providerStatus ?? null,
    });
  }

  return { matched, orphans, lifecycle };
}

/**
 * Full end-to-end: resolve + hand off to lifecycle processor.
 *
 * The caller supplies everything the canonical processor needs
 * (sourceId, pluginKey, policies, guardrails, scope) since those live
 * on the agency's configured source-of-truth identity_source row, not
 * on the HRIS connector itself.
 */
export async function processHrisBatch(params: Parameters<typeof resolveHrisBatch>[0] & {
  sourceOfTruth: Pick<ProcessLifecycleParams, 'sourceId' | 'pluginKey' | 'policies' | 'guardrails' | 'scope'>;
}): Promise<{ matched: number; orphans: number; enqueued: number; processed: number }> {
  const { matched, orphans, lifecycle } = await resolveHrisBatch(params);

  if (matched === 0) {
    return { matched, orphans, enqueued: 0, processed: 0 };
  }

  const result = await processLifecycleEvents({
    sourceId: params.sourceOfTruth.sourceId,
    agencyId: params.agencyId,
    pluginKey: params.sourceOfTruth.pluginKey,
    events: lifecycle,
    policies: params.sourceOfTruth.policies,
    guardrails: params.sourceOfTruth.guardrails,
    scope: params.sourceOfTruth.scope,
  });

  return {
    matched,
    orphans,
    enqueued: result.enqueued,
    processed: result.processed,
  };
}
