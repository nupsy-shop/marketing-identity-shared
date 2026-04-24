/**
 * Approval Step Executor
 *
 * Creates a pam_approvals record and sets status to 'waiting'.
 * Resumes when onResult is called with the approval decision.
 * Supports timeout with escalation or auto-action.
 */

import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';
import type { StepDefinition, WorkflowContext, WorkflowInstance, StepExecutionResult } from '../types.js';

interface ApprovalResult {
  approved?: boolean;
  approvedBy?: string;
  deniedBy?: string;
  action?: string;
  reason?: string;
}

export async function execute(
  step: StepDefinition,
  context: WorkflowContext,
  instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const { prisma } = getRuntime();
  const config = step.config || {};
  const approverRole: string = config.approverRole || 'admin';
  const approverType: string = config.approverType || 'role';

  // Create a pam_approvals record linked to this workflow step
  const triggerData = context.trigger || {};
  const requestId: string = triggerData.requestId || triggerData.accessRequestId || 'workflow';
  const itemId: string = triggerData.itemId || triggerData.accessItemId || 'workflow';
  const platformId: string = triggerData.platformId || 'workflow';
  const requestedBy: string = triggerData.requestedBy || triggerData.userId || 'system';

  const approval = await prisma.pam_approvals.create({
    data: {
      requestId,
      itemId,
      platformId,
      requestedBy,
      status: 'pending',
      durationMinutes: config.timeoutMinutes || 1440,
      agency_id: instance.agency_id,
    },
  });

  publishAuditEvent({
    eventType: 'workflow.approval.requested',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'pam-approval', id: approval.id },
    context: {
      instanceId: instance.id,
      stepId: step.id,
      approverRole,
      approverType,
    },
  }).catch(() => {});

  return {
    status: 'waiting',
    result: {
      approvalId: approval.id,
      approverRole,
      approverType,
    },
    assigneeRole: approverRole,
  };
}

export async function onResult(
  step: StepDefinition,
  result: ApprovalResult,
  _context: WorkflowContext,
  instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const approved = result.approved === true || result.action === 'approve';

  if (approved) {
    publishAuditEvent({
      eventType: 'workflow.approval.approved',
      source: 'accesshive',
      actor: { id: result.approvedBy || 'system', type: 'user' },
      agency: { id: instance.agency_id },
      resource: { type: 'workflow-step', id: step.id },
      context: {
        instanceId: instance.id,
        stepId: step.id,
        approvedBy: result.approvedBy,
      },
    }).catch(() => {});

    return {
      status: 'completed',
      result: {
        approved: true,
        approvedBy: result.approvedBy,
        reason: result.reason,
        resolvedAt: new Date().toISOString(),
      },
    };
  }

  // Denied
  publishAuditEvent({
    eventType: 'workflow.approval.denied',
    source: 'accesshive',
    actor: { id: result.deniedBy || result.approvedBy || 'system', type: 'user' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-step', id: step.id },
    context: {
      instanceId: instance.id,
      stepId: step.id,
      deniedBy: result.deniedBy || result.approvedBy,
      reason: result.reason,
    },
  }).catch(() => {});

  return {
    status: 'failed',
    result: {
      approved: false,
      deniedBy: result.deniedBy || result.approvedBy,
      reason: result.reason,
      resolvedAt: new Date().toISOString(),
    },
  };
}

export async function onTimeout(
  step: StepDefinition,
  _context: WorkflowContext,
  instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const config = step.config || {};
  const onTimeoutAction: string = config.onTimeout || 'auto_deny';

  publishAuditEvent({
    eventType: 'workflow.step.timed_out',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-step', id: step.id },
    context: { instanceId: instance.id, stepId: step.id, timeoutAction: onTimeoutAction },
  }).catch(() => {});

  if (onTimeoutAction === 'auto_approve') {
    return {
      status: 'completed',
      result: {
        approved: true,
        autoApproved: true,
        reason: 'Timeout - auto-approved',
        resolvedAt: new Date().toISOString(),
      },
    };
  }

  if (onTimeoutAction === 'escalate' && config.escalateTo) {
    publishAuditEvent({
      eventType: 'workflow.step.escalated',
      source: 'accesshive',
      actor: { id: 'system', type: 'system' },
      agency: { id: instance.agency_id },
      resource: { type: 'workflow-step', id: step.id },
      context: { instanceId: instance.id, stepId: step.id, escalatedTo: config.escalateTo },
    }).catch(() => {});

    return {
      status: 'completed',
      result: {
        escalated: true,
        reason: 'Timeout - escalated',
        resolvedAt: new Date().toISOString(),
      },
      nextStepId: config.escalateTo,
    };
  }

  // Default: auto_deny
  return {
    status: 'failed',
    result: {
      approved: false,
      autoDenied: true,
      reason: 'Timeout - auto-denied',
      resolvedAt: new Date().toISOString(),
    },
  };
}
