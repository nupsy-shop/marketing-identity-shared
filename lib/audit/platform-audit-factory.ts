/**
 * Platform Audit Poll Factory
 *
 * Builds per-plugin Bull processors that poll a platform's audit log
 * via its `audit-adapter.ts::pollAuditEvents` function and publish
 * events to Elasticsearch.
 *
 * This factory encapsulates behavior that was previously inlined in
 * `lib/audit/platform-poller.ts` (deleted as part of issue #101):
 *
 *   1. Eligibility filter (agency_platforms row exists for this tenant +
 *      platformId, auditIngestionEnabled + auditScopeAuthorized).
 *   2. OAuth token lookup scoped to (agency_id, platformKey, scope=AGENCY).
 *   3. Token refresh via the plugin-supplied refreshToken hook. On
 *      failure, flips auditScopeAuthorized=false and emits
 *      `audit.platform.token_expired`.
 *   4. Adapter invocation with `(accessToken, since, context)`. The
 *      adapter contract is preserved verbatim.
 *   5. Event publishing via publishAuditEvent + flushAll.
 *   6. Cursor persistence to agency_platforms.auditPollCursor and
 *      lastAuditPollAt.
 *
 * Each plugin's processor file supplies:
 *   - `jobName` — the catalog entry for this job (e.g. 'meta_poll_audit')
 *   - `pluginKey` — the catalog_platforms.slug for this plugin
 *   - `pollAuditEvents` — the adapter function from the plugin
 *   - `refreshAccessToken` — plugin-specific token refresh (optional)
 *   - `buildAdapterExtras` — plugin-specific additional context fields
 *     (e.g. { oktaDomain }, { adAccountIds })
 *
 * No raw SQL, Prisma only, agency-scoping on every query — per the
 * project invariants (see MEMORY.md).
 */

import type Bull from 'bull';
import { getRuntime } from '../runtime.js';
import { publishAuditEvent, flushAll, type AuditEventPayload } from './publisher.js';

export interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface AuditAdapterResult {
  events: Record<string, unknown>[];
  cursor?: Record<string, unknown>;
  errors?: string[];
}

/**
 * The adapter function each plugin's `audit-adapter.ts` exports.
 *
 * Typed against `any` (not strict AuditAdapterContext/AuditAdapterResult)
 * at the function-signature boundary because every plugin redeclares
 * those shapes locally with slightly different widths — cursor:
 * Record<string,string> vs Record<string,unknown>, resource.id: string
 * vs string|null, plus plugin-specific extras (oktaDomain,
 * adAccountIds, etc.). Nominal typing via `any` lets each plugin's
 * typed implementation assign cleanly without forcing every plugin to
 * import a canonical set of types. The factory narrows results to
 * AuditAdapterResult internally (see the call site below) before
 * reading events/cursor/errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PollAuditEventsFn = (accessToken: string, since: Date, context: any) => Promise<any>;

export interface OAuthTokenRow {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/**
 * Plugin-specific token-refresh hook.
 *
 * Return the new access token string, or null to signal unrecoverable
 * failure (caller flips auditScopeAuthorized=false).
 *
 * Responsible for persisting the refreshed token via Prisma; the
 * factory will not update oauth_tokens itself.
 */
export type RefreshAccessTokenFn = (token: OAuthTokenRow) => Promise<string | null>;

export interface PlatformAuditProcessorOptions {
  jobName: string;
  pluginKey: string;
  pollAuditEvents: PollAuditEventsFn;
  /** Optional plugin-specific token refresher. Omit for plugins where tokens never expire (e.g. long-lived API keys). */
  refreshAccessToken?: RefreshAccessTokenFn;
  /**
   * Build plugin-specific fields to merge into the adapter context
   * (e.g. { oktaDomain } for Okta, { adAccountIds } for Meta).
   * Given a platform row, return the extras.
   */
  buildAdapterExtras?: (agencyPlatform: {
    id: string;
    agency_id: string;
    admin_config_json: unknown;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface JobResult {
  status: 'completed' | 'skipped';
  jobType: string;
  eventsPublished?: number;
  reason?: string;
}

/**
 * Build a Bull job processor for a plugin's audit-poll job type.
 *
 * Bull job data contract: `{ tenantId: string, platformId: string }`.
 */
export function createPlatformAuditProcessor(
  opts: PlatformAuditProcessorOptions,
): (job: Bull.Job) => Promise<JobResult> {
  const { jobName, pluginKey, pollAuditEvents, refreshAccessToken, buildAdapterExtras } = opts;

  return async function platformAuditProcessor(job: Bull.Job): Promise<JobResult> {
    const { tenantId, platformId } = (job.data ?? {}) as {
      tenantId?: string;
      platformId?: string;
    };

    if (!tenantId || !platformId) {
      throw new Error(`${jobName}: missing required job data { tenantId, platformId }`);
    }

    const { prisma, logger } = getRuntime();

    // 1. Eligibility: platform row for this tenant, ingestion on, scope OK.
    //    Prisma Client field names are snake_case in the worker schema
    //    (@map preserves the camelCase DB columns). The runtime prisma
    //    handle is typed as `any`, so typos here slip past tsc and only
    //    surface as runtime PrismaClientValidationError — that's how the
    //    ga4/meta/salesforce polls were circuit-tripping in production.
    const ap = await prisma.agency_platforms.findFirst({
      where: {
        id: platformId,
        agency_id: tenantId,
        audit_ingestion_enabled: true,
        audit_scope_authorized: true,
        deleted_at: null,
        is_enabled: true,
      },
      select: {
        id: true,
        agency_id: true,
        audit_poll_cursor: true,
        last_audit_poll_at: true,
        admin_config_json: true,
      },
    });

    if (!ap) {
      logger.info(`${jobName}: platform not eligible, skipped`, {
        jobId: String(job.id),
        tenantId,
        platformId,
      });
      return { status: 'skipped', jobType: jobName, eventsPublished: 0, reason: 'not_eligible' };
    }

    // 2. Agency slug for event payloads.
    const agency = await prisma.agencies.findFirst({
      where: { id: tenantId },
      select: { slug: true },
    });
    const agencySlug = agency?.slug ?? '';

    // 3. OAuth token (agency-scoped). Adapter contracts preserve the
    //    single-accessToken argument shape.
    const token = await prisma.oauth_tokens.findFirst({
      where: {
        agency_id: tenantId,
        platformKey: pluginKey,
        isActive: true,
        scope: 'AGENCY',
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    });

    if (!token) {
      // No active OAuth token — emit a token_expired signal and mark
      // the scope unauthorized so the UI prompts a reconnect.
      await prisma.agency_platforms.update({
        where: { id: platformId },
        data: { audit_scope_authorized: false, updated_at: new Date() },
      });
      await publishAuditEvent({
        eventType: 'audit.platform.token_expired',
        source: pluginKey,
        severity: 'warning',
        actor: { id: 'system', email: 'system', type: 'system' },
        agency: { id: tenantId, slug: agencySlug },
        resource: { type: 'platform', id: platformId, name: pluginKey },
        context: { jobName, reason: 'no_active_oauth_token' },
      });
      await flushAll();
      return {
        status: 'completed',
        jobType: jobName,
        eventsPublished: 0,
        reason: 'no_active_oauth_token',
      };
    }

    let accessToken = token.accessToken;

    // 4. Refresh if expired.
    if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
      if (!refreshAccessToken) {
        // Plugin declared no refresher — cannot recover. Flip flag and
        // emit token_expired.
        await prisma.agency_platforms.update({
          where: { id: platformId },
          data: { audit_scope_authorized: false, updated_at: new Date() },
        });
        await publishAuditEvent({
          eventType: 'audit.platform.token_expired',
          source: pluginKey,
          severity: 'warning',
          actor: { id: 'system', email: 'system', type: 'system' },
          agency: { id: tenantId, slug: agencySlug },
          resource: { type: 'platform', id: platformId, name: pluginKey },
          context: { jobName, reason: 'token_expired_no_refresher' },
        });
        await flushAll();
        return { status: 'completed', jobType: jobName, eventsPublished: 0, reason: 'token_expired' };
      }

      const refreshed = await refreshAccessToken({
        id: token.id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      });

      if (!refreshed) {
        await prisma.agency_platforms.update({
          where: { id: platformId },
          data: { audit_scope_authorized: false, updated_at: new Date() },
        });
        await publishAuditEvent({
          eventType: 'audit.platform.token_expired',
          source: pluginKey,
          severity: 'warning',
          actor: { id: 'system', email: 'system', type: 'system' },
          agency: { id: tenantId, slug: agencySlug },
          resource: { type: 'platform', id: platformId, name: pluginKey },
          context: { jobName, reason: 'token_refresh_failed' },
        });
        await flushAll();
        return {
          status: 'completed',
          jobType: jobName,
          eventsPublished: 0,
          reason: 'token_refresh_failed',
        };
      }
      accessToken = refreshed;
    }

    // 5. Poll window.
    const since = ap.last_audit_poll_at
      ? new Date(ap.last_audit_poll_at)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 6. Plugin-specific adapter extras. For agency_platforms the
    //    per-platform admin config lives in admin_config_json (mapped
    //    to adminConfigJson in DB); this is the agency_platforms
    //    analogue of identity_sources.connection_config.
    const extras = buildAdapterExtras
      ? await buildAdapterExtras({
          id: ap.id,
          agency_id: ap.agency_id,
          admin_config_json: ap.admin_config_json,
        })
      : {};

    const context: AuditAdapterContext = {
      agencyId: tenantId,
      agencySlug,
      platformId: ap.id,
      cursor: (ap.audit_poll_cursor as Record<string, unknown> | null) ?? {},
      ...extras,
    };

    // 7. Invoke adapter. The adapter is declared with `any` I/O to allow
    //    each plugin's locally-typed implementation to plug in; cast the
    //    result to the factory's canonical shape at this boundary so the
    //    rest of this function can reason about events/cursor/errors
    //    concretely.
    const result = (await pollAuditEvents(accessToken, since, context)) as AuditAdapterResult;
    const events = result?.events ?? [];

    // 8. Publish events. AuditEventPayload declares an index signature
    //    for custom fields that plugin AuditEvent shapes omit; cast at
    //    this boundary.
    for (const event of events) {
      await publishAuditEvent(event as unknown as AuditEventPayload);
    }
    await flushAll();

    // 9. Persist cursor + lastAuditPollAt.
    await prisma.agency_platforms.update({
      where: { id: ap.id },
      data: {
        audit_poll_cursor: (result.cursor ?? {}) as object,
        last_audit_poll_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (result.errors?.length) {
      logger.warn(`${jobName}: adapter returned ${result.errors.length} non-fatal errors`, {
        jobId: String(job.id),
        tenantId,
        platformId: ap.id,
        errors: result.errors.slice(0, 3),
      });
    }

    logger.info(`${jobName}: published ${events.length} events`, {
      jobId: String(job.id),
      tenantId,
      platformId: ap.id,
    });

    return { status: 'completed', jobType: jobName, eventsPublished: events.length };
  };
}
