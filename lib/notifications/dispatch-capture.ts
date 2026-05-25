import { getRuntime } from '../runtime.js';

/**
 * Reusable E2E capture seam. Records one notification_dispatch_log row when
 * the agency is a test tenant (agencies.is_test_tenant === true); a complete
 * no-op for real tenants. Lets E2E tests assert that an event fanned out to
 * the expected channels without sending real Slack/email.
 */
export async function recordTestDispatch(params: {
  agencyId: string;
  eventType: string;
  channelId?: string | null;
  channelType: string;
  status: 'matched' | 'delivered' | 'failed';
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { prisma, logger } = getRuntime();
  try {
    const agency = await prisma.agencies.findUnique({
      where: { id: params.agencyId },
      select: { is_test_tenant: true },
    });
    if (!agency?.is_test_tenant) return; // inert for real tenants
    await prisma.notification_dispatch_log.create({
      data: {
        agency_id: params.agencyId,
        event_type: params.eventType,
        channel_id: params.channelId ?? null,
        channel_type: params.channelType,
        status: params.status,
        detail: (params.detail ?? {}) as unknown as object,
      },
    });
  } catch (err) {
    logger.warn('[recordTestDispatch] failed', { error: (err as Error).message });
  }
}
