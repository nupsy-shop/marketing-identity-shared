/**
 * Client onboarding kit — shared types (issue #62)
 */

export interface TeamMemberInput {
  email: string;
  firstName?: string;
  lastName?: string;
  /** App role for new users when `source === 'csv'` (maps to processTemplateAssignments + processTeamMembers). */
  userType?: string;
  /** Either 'csv' (create new user) or 'directory' (existing user). */
  source: 'csv' | 'directory';
  /** Role template key to assign on the client. */
  roleTemplateKey?: string;
}

export interface ApplyKitInput {
  kitKey: string;
  teamMembers: TeamMemberInput[];
  welcomeOverride?: string;
}

export type RunStepName =
  | 'attach_platforms'
  | 'install_templates'
  | 'create_team'
  | 'provision_team'
  | 'notify';

/** Run-level step status (NOT the integration_identities.provisioning_status enum). */
export type RunStepStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface RunStep {
  name: RunStepName;
  status: RunStepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Optional free-form per-member outcome details. */
  outcomes?: Array<{ email: string; status: string; error?: string }>;
}

export interface RunSummary {
  steps: RunStep[];
  counts?: {
    teamMembers?: number;
    provisioned?: number;
    failed?: number;
    welcomesSent?: number;
  };
}

export const RUN_STEP_ORDER: RunStepName[] = [
  'attach_platforms',
  'install_templates',
  'create_team',
  'provision_team',
  'notify',
];
