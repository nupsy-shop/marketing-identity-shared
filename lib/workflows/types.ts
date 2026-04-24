/**
 * Shared type definitions for the workflow engine.
 */

/** Configuration attached to a workflow step definition. */
export interface StepConfig {
  eventType?: string;
  actionType?: string;
  params?: Record<string, unknown>;
  expression?: string;
  trueBranch?: string;
  falseBranch?: string;
  approverType?: string;
  approverRole?: string;
  timeoutMinutes?: number;
  onTimeout?: string;
  escalateTo?: string;
  channels?: string[];
  templateKey?: string;
  recipientType?: string;
  recipientRole?: string;
  recipientUserId?: string;
  [key: string]: unknown;
}

/** A single step inside a workflow definition's `steps` array. */
export interface StepDefinition {
  id: string;
  type: string;
  config?: StepConfig;
  next?: string | null;
}

/** The runtime context object threaded through step executions. */
export interface WorkflowContext {
  trigger?: Record<string, string | undefined>;
  [key: string]: unknown;
}

/** Instance status values. */
export type InstanceStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** Step execution status values. */
export type StepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

/** A workflow instance row from the database. */
export interface WorkflowInstance {
  id: string;
  definition_id: string;
  definition_version: number;
  agency_id: string;
  trigger_data: Record<string, unknown>;
  current_step_id: string | null;
  status: InstanceStatus;
  context: WorkflowContext;
  started_at: Date;
  completed_at: Date | null;
}

/** A workflow definition row from the database. */
export interface WorkflowDefinition {
  id: string;
  agency_id: string | null;
  key: string;
  name: string;
  description: string | null;
  version: number;
  trigger_type: string;
  steps: StepDefinition[];
  is_system: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** The result returned by a step executor. */
export interface StepExecutionResult {
  status: 'completed' | 'waiting' | 'failed';
  result: Record<string, unknown>;
  nextStepId?: string | null;
  assigneeId?: string;
  assigneeRole?: string;
}

/** A step execution row from the database. */
export interface StepExecution {
  id: string;
  instance_id: string;
  step_id: string;
  step_type: string;
  status: StepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
  timeout_at: Date | null;
  assignee_id: string | null;
  assignee_role: string | null;
  agency_id: string;
}

/** Interface that step executor modules must satisfy. */
export interface StepExecutor {
  execute: (step: StepDefinition, context: WorkflowContext, instance: WorkflowInstance) => Promise<StepExecutionResult>;
  onResult?: (step: StepDefinition, result: Record<string, unknown>, context: WorkflowContext, instance: WorkflowInstance) => Promise<StepExecutionResult>;
  onTimeout?: (step: StepDefinition, context: WorkflowContext, instance: WorkflowInstance) => Promise<StepExecutionResult>;
}

/** Template tier level. */
export type TemplateTier = 'free' | 'starter' | 'growth' | 'business';

/** A system workflow template definition (static data). */
export interface SystemTemplate {
  key: string;
  name: string;
  description: string;
  trigger_type: string;
  tier: TemplateTier;
  steps: StepDefinition[];
}
