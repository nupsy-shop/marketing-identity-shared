/**
 * Action Step Executor
 *
 * Executes a business action. The central dict holds only workflow-engine
 * primitives used by every trigger type (access requests, remediations,
 * breakglass, revert):
 *
 *   grant_access, revoke_access, create_task, update_status,
 *   capture_before_state, restore_before_state
 *
 * Plugin-specific remediation actions (e.g. `local-directory:link_keycloak_identity`)
 * live in the plugin's `remediations/index.ts` and are resolved through the
 * plugin remediations registry. See
 * `shared/plugins/identity/remediations-registry.ts` + issue #92.
 *
 * Resolution order:
 *   1. central dict  (un-namespaced primitives)
 *   2. plugin registry (namespaced `<plugin-key>:<action>` types)
 *   3. fail step with "Unknown action type"
 */

import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';
import { getRemediationHandler } from '../../../plugins/identity/remediations-registry.js';
import type { StepDefinition, WorkflowContext, WorkflowInstance, StepExecutionResult } from '../types.js';

// ---- Action Handler Types --------------------------------------------------

interface ActionResult {
  actionCompleted: boolean;
  actionType: string;
  executedAt: string;
  taskParams?: Record<string, unknown>;
  statusParams?: Record<string, unknown>;
  beforeState?: Record<string, unknown>;
  reprovision?: Record<string, unknown>;
  revocation?: Record<string, unknown>;
}

type ActionHandler = (
  params: Record<string, unknown>,
  context: WorkflowContext,
  instance: WorkflowInstance,
) => Promise<ActionResult>;

// ---- Central Action Handlers ----------------------------------------------
//
// Central = workflow-engine primitives. Plugin-specific actions live in the
// plugin remediations registry (see file header). Adding a new IdP must
// NOT require touching this dict.

const actionHandlers: Record<string, ActionHandler> = {
  grant_access: async (params, context, instance) => {
    publishAuditEvent({
      eventType: 'access.granted',
      source: 'accesshive',
      actor: { id: 'system', type: 'system' },
      agency: { id: instance.agency_id },
      resource: {
        type: 'access-item',
        id: context.trigger?.accessItemId || context.trigger?.itemId || 'unknown',
      },
      context: {
        workflowInstanceId: instance.id,
        grantedViaWorkflow: true,
        ...params,
      },
    }).catch(() => {});

    return {
      actionCompleted: true,
      actionType: 'grant_access',
      executedAt: new Date().toISOString(),
    };
  },

  revoke_access: async (params, context, instance) => {
    const { prisma } = getRuntime();

    // Resolve target user + items from the remediation context that seeded
    // this workflow. Shape matches what `remediation-workflow.ts` passes into
    // `startWorkflow()`: `{ remediation: { id, triggerType }, ...context }`.
    const triggerCtx = (context.trigger || {}) as Record<string, unknown>;
    const userId = (triggerCtx.userId || triggerCtx.targetUserId) as string | undefined;
    const userEmail = (triggerCtx.userEmail || triggerCtx.targetEmail) as string | undefined;
    const itemIds = triggerCtx.accessRequestItemIds as string[] | undefined;
    const triggerType =
      ((triggerCtx.remediation as Record<string, unknown> | undefined)?.triggerType as string | undefined) ||
      'auto_remediation';

    const revocation: Record<string, unknown> = { revoked: 0 };

    if (itemIds?.length) {
      for (const itemId of itemIds) {
        await prisma.access_request_items.update({
          where: { id: itemId },
          data: { status: 'revoked', updatedAt: new Date() },
        });
      }
      revocation.revoked = itemIds.length;
      revocation.itemIds = itemIds;
    } else if (userId || userEmail) {
      // Lazy import — revocation-engine has a dep chain we don't want to pull
      // into every workflow action load.
      const mod = await import('@/lib/jml/revocation-engine').catch(() => null);
      const revokeAllPlatformAccess = mod?.revokeAllPlatformAccess;
      if (!revokeAllPlatformAccess) {
        revocation.note = 'revocation-engine not available on this runtime';
      } else {
        const out = (await revokeAllPlatformAccess(
          instance.agency_id,
          userId || '',
          triggerType,
          userEmail,
        )) as Record<string, unknown>;
        Object.assign(revocation, out);
      }
    } else {
      revocation.note = 'No target user or items to revoke';
    }

    publishAuditEvent({
      eventType: 'access.revoked',
      source: 'accesshive',
      actor: { id: 'system', type: 'system' },
      agency: { id: instance.agency_id },
      resource: {
        type: 'access-item',
        id: (triggerCtx.accessItemId as string) || (triggerCtx.itemId as string) || userId || 'unknown',
      },
      context: {
        workflowInstanceId: instance.id,
        revokedViaWorkflow: true,
        revocation,
        ...params,
      },
    }).catch(() => {});

    return {
      actionCompleted: true,
      actionType: 'revoke_access',
      executedAt: new Date().toISOString(),
      revocation,
    };
  },

  /**
   * Capture the current state of the targets so a later revert workflow can
   * restore it. Writes `beforeState` into this action's result; the engine
   * merges it into the workflow instance's context, making it addressable by
   * revert as `context.beforeState`.
   */
  capture_before_state: async (_params, context) => {
    const { prisma } = getRuntime();

    const triggerCtx = (context.trigger || {}) as Record<string, unknown>;
    const beforeState: Record<string, unknown> = {};
    const itemIds = triggerCtx.accessRequestItemIds as string[] | undefined;
    if (itemIds?.length) {
      const rows = await prisma.access_request_items.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, status: true },
      });
      beforeState.accessRequestItemIds = rows.map((r: { id: string; status: string }) => r.id);
      beforeState.previousStatuses = rows.map((r: { id: string; status: string }) => r.status);
    }
    if (triggerCtx.userId) beforeState.userId = triggerCtx.userId;
    if (triggerCtx.userEmail) beforeState.userEmail = triggerCtx.userEmail;
    if (triggerCtx.platformKey) beforeState.platformKey = triggerCtx.platformKey;

    return {
      actionCompleted: true,
      actionType: 'capture_before_state',
      executedAt: new Date().toISOString(),
      beforeState,
    };
  },

  /**
   * Restore the pre-remediation state. Invoked by the `revert-remediation`
   * workflow. Reads the original remediation row + its workflow instance to
   * locate the captured `beforeState`, then flips access_request_items back
   * and asks the revocation engine to re-provision platform access.
   */
  restore_before_state: async (_params, context, instance) => {
    const { prisma } = getRuntime();

    const triggerCtx = (context.trigger || {}) as Record<string, unknown>;
    const remediationId = triggerCtx.remediationId as string | undefined;
    if (!remediationId) {
      throw new Error('restore_before_state: remediationId missing from trigger');
    }

    const remediation = await prisma.remediations.findFirst({
      where: { id: remediationId, agency_id: instance.agency_id },
    });
    if (!remediation) {
      throw new Error(`restore_before_state: remediation ${remediationId} not found`);
    }

    // Look up beforeState first from the original workflow instance's context
    // (post-#93 behaviour), then fall back to the deprecated column (legacy
    // rows). Order matches the spec's transition plan.
    let beforeState: Record<string, unknown> = {};
    if (remediation.workflow_instance_id) {
      const origInstance = await prisma.workflow_instances.findFirst({
        where: {
          id: remediation.workflow_instance_id,
          agency_id: instance.agency_id,
        },
        select: { context: true },
      });
      const origCtx = (origInstance?.context as Record<string, unknown> | null) || {};
      if (origCtx.beforeState && typeof origCtx.beforeState === 'object') {
        beforeState = origCtx.beforeState as Record<string, unknown>;
      }
    }
    if (!Object.keys(beforeState).length) {
      beforeState = (remediation.before_state as Record<string, unknown>) || {};
    }

    const itemIds = beforeState.accessRequestItemIds as string[] | undefined;
    const prevStatuses = beforeState.previousStatuses as string[] | undefined;
    if (itemIds?.length && prevStatuses?.length) {
      for (let i = 0; i < itemIds.length; i++) {
        await prisma.access_request_items.update({
          where: { id: itemIds[i] },
          data: { status: prevStatuses[i] || 'completed', updatedAt: new Date() },
        });
      }
    }

    const reprovision: Record<string, unknown> = {
      attempted: false,
      reprovisioned: 0,
      errors: [] as string[],
    };
    try {
      const mod = await import('@/lib/jml/revocation-engine').catch(() => null);
      const reprovisionFn =
        mod && typeof (mod as Record<string, unknown>).reprovisionAccess === 'function'
          ? ((mod as Record<string, unknown>).reprovisionAccess as (
              agencyId: string,
              userId: string,
              reason: string,
            ) => Promise<{ reprovisioned?: number } | undefined>)
          : null;
      const userId = remediation.target_user_id;
      if (reprovisionFn && userId) {
        reprovision.attempted = true;
        const out = await reprovisionFn(
          instance.agency_id,
          userId,
          `revert:${remediation.trigger_type}`,
        );
        reprovision.reprovisioned = out?.reprovisioned || 0;
      } else if (!reprovisionFn) {
        reprovision.note = 'Platform re-provisioning not yet wired — records restored only';
      } else {
        reprovision.note = 'No target user — records restored only';
      }
    } catch (err) {
      (reprovision.errors as string[]).push(
        err instanceof Error ? err.message : String(err),
      );
    }

    // Flip the original remediation to `reverted` so the operator list
    // reflects it immediately. Status transitions + audit are driven by the
    // workflow engine for the revert workflow itself.
    await prisma.remediations.update({
      where: { id: remediationId },
      data: {
        status: 'reverted',
        reverted_at: new Date(),
        updated_at: new Date(),
      },
    });

    return {
      actionCompleted: true,
      actionType: 'restore_before_state',
      executedAt: new Date().toISOString(),
      reprovision,
    };
  },

  create_task: async (params) => {
    return {
      actionCompleted: true,
      actionType: 'create_task',
      executedAt: new Date().toISOString(),
      taskParams: params,
    };
  },

  update_status: async (params) => {
    return {
      actionCompleted: true,
      actionType: 'update_status',
      executedAt: new Date().toISOString(),
      statusParams: params,
    };
  },
};

// ---- Resolver --------------------------------------------------------------

/**
 * Resolve a handler for the given action type:
 *   1. central dict (primitives)
 *   2. plugin registry (namespaced `<plugin-key>:<action>`)
 *   3. null → caller fails the step
 */
function resolveHandler(actionType: string): ActionHandler | null {
  const central = actionHandlers[actionType];
  if (central) return central;

  const pluginHandler = getRemediationHandler(actionType);
  if (pluginHandler) {
    // Adapt the plugin contract's structural types to the host's
    // WorkflowContext/WorkflowInstance. They are structurally compatible.
    return pluginHandler as unknown as ActionHandler;
  }

  return null;
}

// ---- Executor --------------------------------------------------------------

export async function execute(
  step: StepDefinition,
  context: WorkflowContext,
  instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const config = step.config || {};
  const actionType: string | undefined = config.actionType;

  if (!actionType) {
    return {
      status: 'failed',
      result: { error: 'Action step has no actionType configured' },
    };
  }

  const handler = resolveHandler(actionType);
  if (!handler) {
    return {
      status: 'failed',
      result: { error: `Unknown action type: ${actionType}` },
    };
  }

  try {
    const result = await handler((config.params as Record<string, unknown>) || {}, context, instance);
    return {
      status: 'completed',
      result: result as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return {
      status: 'failed',
      result: { error: (err as Error).message, actionType },
    };
  }
}

export async function onResult(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}

export async function onTimeout(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}
