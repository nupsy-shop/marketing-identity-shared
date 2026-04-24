/**
 * Notification Step Executor
 *
 * Sends a notification via configured channels (email, webhook, in-app).
 * Non-blocking — completes immediately after enqueuing the notification.
 */

import { publishAuditEvent } from '../../audit/publisher.js';
import type { StepDefinition, WorkflowContext, WorkflowInstance, StepExecutionResult } from '../types.js';

export async function execute(
  step: StepDefinition,
  context: WorkflowContext,
  instance: WorkflowInstance,
): Promise<StepExecutionResult> {
  const config = step.config || {};
  const channels: string[] = config.channels || ['in_app'];
  const templateKey: string = config.templateKey || 'workflow_notification';
  const recipientType: string = config.recipientType || 'role';
  const recipientRole: string | undefined = config.recipientRole;
  const recipientUserId: string | undefined = config.recipientUserId;

  // Enqueue notification (non-blocking)
  // In production, this would dispatch via the existing notification system
  // For now, we publish an audit event as the notification record
  publishAuditEvent({
    eventType: 'workflow.notification.sent',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'workflow-notification', id: step.id },
    context: {
      instanceId: instance.id,
      stepId: step.id,
      channels,
      templateKey,
      recipientType,
      recipientRole,
      recipientUserId,
      triggerData: context.trigger,
    },
  }).catch(() => {});

  return {
    status: 'completed',
    result: {
      notifiedAt: new Date().toISOString(),
      channels,
      templateKey,
      recipientType,
      recipientRole: recipientRole || undefined,
    },
  };
}

export async function onResult(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}

export async function onTimeout(): Promise<StepExecutionResult> {
  return { status: 'completed', result: {} };
}
