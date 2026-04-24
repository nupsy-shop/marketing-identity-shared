/**
 * Condition Step Executor
 *
 * Evaluates a boolean expression against workflow context.
 * Returns trueBranch or falseBranch as the nextStepId.
 * Completes immediately.
 */

import { evaluateCondition } from '../evaluator.js';
import type { StepDefinition, WorkflowContext, WorkflowInstance, StepExecutionResult } from '../types.js';

export async function execute(
  step: StepDefinition,
  context: WorkflowContext,
  _instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const expression = step.config?.expression;
  if (!expression) {
    return {
      status: 'failed',
      result: { error: 'Condition step has no expression configured' },
    };
  }

  const result = evaluateCondition(expression, context);

  const nextStepId = result
    ? step.config?.trueBranch
    : step.config?.falseBranch;

  return {
    status: 'completed',
    result: {
      conditionResult: result,
      expression,
      branch: result ? 'true' : 'false',
    },
    nextStepId: nextStepId || step.next,
  };
}

export async function onResult(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}

export async function onTimeout(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}
