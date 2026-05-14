/**
 * Workflow Engine Runtime
 *
 * Stateless between calls — all state is persisted in PostgreSQL.
 * The engine creates and advances workflow instances by delegating
 * execution to pluggable step executors.
 */

import { getRuntime } from '../runtime.js';
import { Prisma } from '@prisma/client';
import { publishAuditEvent } from '../audit/publisher.js';
import type {
  StepDefinition,
  StepExecutor,
  StepExecutionResult,
  WorkflowContext,
  WorkflowInstance,
} from './types.js';

// Step executor registry — lazy-loaded
const executors: Record<string, StepExecutor> = {};

async function getExecutor(stepType: string): Promise<StepExecutor | null> {
  if (executors[stepType]) return executors[stepType];

  const { logger } = getRuntime();
  try {
    const mod: StepExecutor = await import(`./steps/${stepType}.js`);
    executors[stepType] = mod;
    return mod;
  } catch (err) {
    logger.error(`[Workflow Engine] No executor for step type: ${stepType}`, { message: (err as Error).message });
    return null;
  }
}

// ---- Start Workflow --------------------------------------------------------

/**
 * Create a new workflow instance and execute its first step.
 *
 * @param definitionId - The workflow definition UUID
 * @param triggerData - The event payload that started this workflow
 * @param agencyId - Tenant scope
 * @returns The created workflow instance
 */
export async function startWorkflow(
  definitionId: string,
  triggerData: Record<string, unknown>,
  agencyId: string,
): Promise<WorkflowInstance> {
  const { prisma } = getRuntime();

  // Load definition
  const definition = await prisma.workflow_definitions.findUnique({
    where: { id: definitionId },
  });
  if (!definition) throw new Error(`Workflow definition not found: ${definitionId}`);
  if (!definition.is_active) throw new Error(`Workflow definition is inactive: ${definitionId}`);

  const steps = definition.steps as StepDefinition[] | null;
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    throw new Error(`Workflow definition has no steps: ${definitionId}`);
  }

  // Create instance
  const instance = await prisma.workflow_instances.create({
    data: {
      definition_id: definitionId,
      definition_version: definition.version,
      agency_id: agencyId,
      trigger_data: triggerData as Prisma.InputJsonValue,
      current_step_id: steps[0].id,
      status: 'running',
      context: { trigger: triggerData } as Prisma.InputJsonValue,
      started_at: new Date(),
    },
  });

  // Publish audit event
  publishAuditEvent({
    eventType: 'workflow.instance.started',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: agencyId },
    resource: { type: 'workflow-instance', id: instance.id },
    context: { definitionId, definitionKey: definition.key, triggerData },
  }).catch(() => {});

  // Execute first step
  await executeStep(instance as unknown as WorkflowInstance, steps[0], steps);

  // Re-fetch to get updated state
  const updated = await prisma.workflow_instances.findUnique({ where: { id: instance.id } });
  return updated as unknown as WorkflowInstance;
}

// ---- Advance Workflow ------------------------------------------------------

/**
 * Advance a workflow by resolving a waiting step with a result.
 *
 * @param instanceId - The workflow instance UUID
 * @param stepResult - The result from the external event
 * @returns The updated workflow instance
 */
export async function advanceWorkflow(
  instanceId: string,
  stepResult: Record<string, unknown>,
): Promise<WorkflowInstance> {
  const { prisma } = getRuntime();

  const instance = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
  if (!instance) throw new Error(`Workflow instance not found: ${instanceId}`);
  if (instance.status !== 'running' && instance.status !== 'waiting') {
    throw new Error(`Workflow instance is ${instance.status}, cannot advance`);
  }

  // Load definition
  const definition = await prisma.workflow_definitions.findUnique({ where: { id: instance.definition_id } });
  const steps = definition!.steps as unknown as StepDefinition[];

  // Find the current waiting step execution
  const stepExec = await prisma.workflow_step_executions.findFirst({
    where: { instance_id: instanceId, status: 'waiting' },
    orderBy: { started_at: 'desc' },
  });
  if (!stepExec) throw new Error('No waiting step execution found');

  // Find step definition
  const stepDef = steps.find(s => s.id === stepExec.step_id);
  if (!stepDef) throw new Error(`Step definition not found: ${stepExec.step_id}`);

  // Call executor's onResult
  const executor = await getExecutor(stepDef.type);
  if (!executor?.onResult) {
    throw new Error(`Step type ${stepDef.type} does not support onResult`);
  }

  const context = (instance.context || {}) as WorkflowContext;
  const result: StepExecutionResult = await executor.onResult(
    stepDef,
    stepResult,
    context,
    instance as unknown as WorkflowInstance,
  );

  // Update step execution
  await prisma.workflow_step_executions.update({
    where: { id: stepExec.id },
    data: {
      status: result.status,
      output: (result.result || {}) as Prisma.InputJsonValue,
      completed_at: new Date(),
    },
  });

  // Update context
  const updatedContext = { ...context, ...result.result };
  await prisma.workflow_instances.update({
    where: { id: instanceId },
    data: { context: updatedContext as Prisma.InputJsonValue },
  });

  // Publish step completed audit
  publishAuditEvent({
    eventType: `workflow.step.${result.status}`,
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-step', id: stepExec.id },
    context: { instanceId, stepId: stepDef.id, stepType: stepDef.type, result: result.result },
  }).catch(() => {});

  if (result.status === 'completed') {
    // Determine next step
    const nextStepId = result.nextStepId || stepDef.next;
    if (nextStepId) {
      const nextStep = steps.find(s => s.id === nextStepId);
      if (nextStep) {
        await prisma.workflow_instances.update({
          where: { id: instanceId },
          data: { current_step_id: nextStepId, status: 'running' },
        });
        // Re-fetch instance with updated context
        const refreshed = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
        await executeStep(refreshed as unknown as WorkflowInstance, nextStep, steps);
      } else {
        await completeInstance(instanceId, instance.agency_id);
      }
    } else {
      await completeInstance(instanceId, instance.agency_id);
    }
  } else if (result.status === 'failed') {
    await failInstance(instanceId, stepDef.id, 'Step failed', instance.agency_id);
  }

  const updated = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
  return updated as unknown as WorkflowInstance;
}

// ---- Handle Timeout --------------------------------------------------------

/**
 * Handle a timed-out step execution.
 *
 * @param instanceId - The workflow instance UUID
 * @param stepExecId - The step execution UUID
 */
export async function handleTimeout(instanceId: string, stepExecId: string): Promise<void> {
  const { prisma } = getRuntime();

  const instance = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
  if (!instance || (instance.status !== 'running' && instance.status !== 'waiting')) return;

  const definition = await prisma.workflow_definitions.findUnique({ where: { id: instance.definition_id } });
  const steps = definition!.steps as unknown as StepDefinition[];

  const stepExec = await prisma.workflow_step_executions.findUnique({ where: { id: stepExecId } });
  if (!stepExec || stepExec.status !== 'waiting') return;

  const stepDef = steps.find(s => s.id === stepExec.step_id);
  if (!stepDef) return;

  const executor = await getExecutor(stepDef.type);
  if (!executor?.onTimeout) {
    // Default: fail the step
    await prisma.workflow_step_executions.update({
      where: { id: stepExecId },
      data: { status: 'timed_out', completed_at: new Date() },
    });
    await failInstance(instanceId, stepDef.id, 'Step timed out', instance.agency_id);
    return;
  }

  const context = (instance.context || {}) as WorkflowContext;
  const result: StepExecutionResult = await executor.onTimeout(
    stepDef,
    context,
    instance as unknown as WorkflowInstance,
  );

  // Update step execution
  await prisma.workflow_step_executions.update({
    where: { id: stepExecId },
    data: {
      status: result.status === 'completed' ? 'completed' : 'timed_out',
      output: (result.result || {}) as Prisma.InputJsonValue,
      completed_at: new Date(),
    },
  });

  publishAuditEvent({
    eventType: 'workflow.step.timed_out',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-step', id: stepExecId },
    context: {
      instanceId, stepId: stepDef.id, stepType: stepDef.type,
      timeoutAction: stepDef.config?.onTimeout || 'default',
    },
  }).catch(() => {});

  if (result.status === 'completed') {
    const updatedContext = { ...context, ...result.result };
    await prisma.workflow_instances.update({
      where: { id: instanceId },
      data: { context: updatedContext as Prisma.InputJsonValue },
    });

    const nextStepId = result.nextStepId || stepDef.next;
    if (nextStepId) {
      const nextStep = steps.find(s => s.id === nextStepId);
      if (nextStep) {
        await prisma.workflow_instances.update({
          where: { id: instanceId },
          data: { current_step_id: nextStepId, status: 'running' },
        });
        const refreshed = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
        await executeStep(refreshed as unknown as WorkflowInstance, nextStep, steps);
      } else {
        await completeInstance(instanceId, instance.agency_id);
      }
    } else {
      await completeInstance(instanceId, instance.agency_id);
    }
  } else {
    await failInstance(instanceId, stepDef.id, 'Step timed out', instance.agency_id);
  }
}

// ---- Cancel Workflow -------------------------------------------------------

/**
 * Cancel a running workflow instance.
 *
 * @param instanceId - The workflow instance UUID
 * @param reason - Cancellation reason
 */
export async function cancelWorkflow(instanceId: string, reason: string): Promise<void> {
  const { prisma } = getRuntime();

  const instance = await prisma.workflow_instances.findUnique({ where: { id: instanceId } });
  if (!instance) throw new Error(`Workflow instance not found: ${instanceId}`);

  // Cancel any in-flight step executions
  await prisma.workflow_step_executions.updateMany({
    where: {
      instance_id: instanceId,
      status: { in: ['pending', 'running', 'waiting'] },
    },
    data: { status: 'cancelled', completed_at: new Date() },
  });

  // Update instance
  const context = { ...((instance.context as WorkflowContext) || {}), cancelReason: reason };
  await prisma.workflow_instances.update({
    where: { id: instanceId },
    data: {
      status: 'cancelled',
      current_step_id: null,
      context,
      completed_at: new Date(),
    },
  });

  publishAuditEvent({
    eventType: 'workflow.instance.cancelled',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-instance', id: instanceId },
    context: { reason },
  }).catch(() => {});
}

// ---- Internal Helpers ------------------------------------------------------

async function executeStep(
  instance: WorkflowInstance,
  stepDef: StepDefinition,
  allSteps: StepDefinition[],
): Promise<void> {
  const { prisma, logger } = getRuntime();

  const executor = await getExecutor(stepDef.type);
  if (!executor) {
    await failInstance(instance.id, stepDef.id, `No executor for step type: ${stepDef.type}`, instance.agency_id);
    return;
  }

  // stepExec is declared here so the catch block can reference it even if the
  // create call itself throws (in which case stepExec remains undefined and the
  // catch skips the status-update, going straight to failInstance).
  let stepExec: { id: string } | undefined;

  try {
    // Create step execution record inside try so a DB write failure is handled
    // gracefully rather than propagating as an unhandled exception to the caller.
    const created = await prisma.workflow_step_executions.create({
      data: {
        instance_id: instance.id,
        step_id: stepDef.id,
        step_type: stepDef.type,
        status: 'running',
        input: (instance.context || {}) as Prisma.InputJsonValue,
        started_at: new Date(),
        agency_id: instance.agency_id,
      },
    });
    // Publish to the outer binding so the catch block can tell whether the row
    // exists; `created` stays the definitely-defined local for the rest of the try.
    stepExec = created;

    publishAuditEvent({
      eventType: 'workflow.step.started',
      source: 'accesshive',
      actor: { id: 'system', type: 'system' },
      agency: { id: instance.agency_id },
      resource: { type: 'workflow-step', id: created.id },
      context: { instanceId: instance.id, stepId: stepDef.id, stepType: stepDef.type },
    }).catch(() => {});

    const context: WorkflowContext = (instance.context || {}) as WorkflowContext;
    const result: StepExecutionResult = await executor.execute(stepDef, context, instance);

    if (result.status === 'completed') {
      // Mark step completed
      await prisma.workflow_step_executions.update({
        where: { id: created.id },
        data: {
          status: 'completed',
          output: (result.result || {}) as Prisma.InputJsonValue,
          completed_at: new Date(),
        },
      });

      // Update context
      const updatedContext = { ...context, ...result.result };
      await prisma.workflow_instances.update({
        where: { id: instance.id },
        data: { context: updatedContext as Prisma.InputJsonValue },
      });

      publishAuditEvent({
        eventType: 'workflow.step.completed',
        source: 'accesshive',
        actor: { id: 'system', type: 'system' },
        agency: { id: instance.agency_id },
        resource: { type: 'workflow-step', id: created.id },
        context: { instanceId: instance.id, stepId: stepDef.id, result: result.result },
      }).catch(() => {});

      // Advance to next step
      const nextStepId = result.nextStepId || stepDef.next;
      if (nextStepId) {
        const nextStep = allSteps.find(s => s.id === nextStepId);
        if (nextStep) {
          await prisma.workflow_instances.update({
            where: { id: instance.id },
            data: { current_step_id: nextStepId },
          });
          // Re-fetch instance with updated context
          const refreshed = await prisma.workflow_instances.findUnique({ where: { id: instance.id } });
          await executeStep(refreshed as unknown as WorkflowInstance, nextStep, allSteps);
        } else {
          await completeInstance(instance.id, instance.agency_id);
        }
      } else {
        await completeInstance(instance.id, instance.agency_id);
      }

    } else if (result.status === 'waiting') {
      // Set step to waiting with optional timeout
      const timeoutAt = stepDef.config?.timeoutMinutes
        ? new Date(Date.now() + stepDef.config.timeoutMinutes * 60 * 1000)
        : null;

      await prisma.workflow_step_executions.update({
        where: { id: created.id },
        data: {
          status: 'waiting',
          timeout_at: timeoutAt,
          assignee_id: result.assigneeId || null,
          assignee_role: result.assigneeRole || null,
        },
      });

      // Set instance to waiting
      await prisma.workflow_instances.update({
        where: { id: instance.id },
        data: { status: 'waiting' },
      });

    } else if (result.status === 'failed') {
      await prisma.workflow_step_executions.update({
        where: { id: created.id },
        data: {
          status: 'failed',
          output: (result.result || {}) as Prisma.InputJsonValue,
          completed_at: new Date(),
        },
      });

      publishAuditEvent({
        eventType: 'workflow.step.failed',
        source: 'accesshive',
        actor: { id: 'system', type: 'system' },
        agency: { id: instance.agency_id },
        resource: { type: 'workflow-step', id: created.id },
        context: { instanceId: instance.id, stepId: stepDef.id, error: result.result?.error },
      }).catch(() => {});

      await failInstance(instance.id, stepDef.id, result.result?.error as string | undefined, instance.agency_id);
    }
  } catch (err) {
    logger.error(`[Workflow Engine] Step execution error`, { message: err instanceof Error ? err.message : String(err) });
    // Only update the step execution record if the create succeeded; if stepExec
    // is undefined the create itself threw (e.g. constraint violation) and there
    // is no row to update.
    if (stepExec) {
      await prisma.workflow_step_executions.update({
        where: { id: stepExec.id },
        data: {
          status: 'failed',
          output: { error: (err as Error).message },
          completed_at: new Date(),
        },
      });
    }
    await failInstance(instance.id, stepDef.id, (err as Error).message, instance.agency_id);
  }
}

async function completeInstance(instanceId: string, agencyId: string): Promise<void> {
  const { prisma } = getRuntime();

  await prisma.workflow_instances.update({
    where: { id: instanceId },
    data: {
      status: 'completed',
      current_step_id: null,
      completed_at: new Date(),
    },
  });

  publishAuditEvent({
    eventType: 'workflow.instance.completed',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: agencyId },
    resource: { type: 'workflow-instance', id: instanceId },
  }).catch(() => {});
}

async function failInstance(
  instanceId: string,
  failedStepId: string,
  error: string | undefined,
  agencyId: string,
): Promise<void> {
  const { prisma } = getRuntime();

  await prisma.workflow_instances.update({
    where: { id: instanceId },
    data: {
      status: 'failed',
      completed_at: new Date(),
    },
  });

  publishAuditEvent({
    eventType: 'workflow.instance.failed',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: agencyId },
    resource: { type: 'workflow-instance', id: instanceId },
    context: { failedStepId, error },
  }).catch(() => {});
}
