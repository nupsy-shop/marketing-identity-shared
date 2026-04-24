/**
 * Trigger Step Executor
 *
 * Records the event that started the workflow.
 * No execution logic — captures triggerData into context and completes immediately.
 */

import type { StepDefinition, WorkflowContext, WorkflowInstance, StepExecutionResult } from '../types.js';

export async function execute(
  step: StepDefinition,
  _context: WorkflowContext,
  _instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  return {
    status: 'completed',
    result: {
      triggeredAt: new Date().toISOString(),
      eventType: step.config?.eventType || 'unknown',
    },
  };
}

export async function onResult(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}

export async function onTimeout(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}
