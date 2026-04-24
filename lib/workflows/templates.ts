/**
 * Workflow Templates
 *
 * Pre-built workflow definitions covering common patterns.
 * System templates have is_system = true and agency_id = NULL.
 */

import { getRuntime } from '../runtime.js';
import { Prisma } from '@prisma/client';
import { getAllRemediationTemplates } from '../../plugins/identity/remediations-registry.js';
import type { SystemTemplate, TemplateTier, WorkflowDefinition } from './types.js';

// ---- Central Template Definitions -----------------------------------------
//
// These are workflow-engine-owned templates (access requests, remediation
// revoke/revert, breakglass). Plugin-specific drift templates (e.g.
// `drift-link-keycloak-identity`) live in each plugin's
// `remediations/index.ts` and are merged in at boot via
// `getAllRemediationTemplates()` — see `SYSTEM_TEMPLATES` below.

const CENTRAL_TEMPLATES: SystemTemplate[] = [
  {
    key: 'auto-approve',
    name: 'Auto Approve',
    description: 'Automatically grants access without any approval step. Suitable for low-risk, pre-authorized access.',
    trigger_type: 'access_request',
    tier: 'free',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      { id: 'step-2', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'standard',
    name: 'Standard Approval',
    description: 'Single-level approval from an operations admin. Good for standard access requests.',
    trigger_type: 'access_request',
    tier: 'starter',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      {
        id: 'step-2', type: 'approval',
        config: { approverType: 'role', approverRole: 'ops_admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-3',
      },
      { id: 'step-3', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'dual-approval',
    name: 'Dual Approval',
    description: 'Two-level sequential approval for standard access requests. First ops admin, then security admin.',
    trigger_type: 'access_request',
    tier: 'growth',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      {
        id: 'step-2', type: 'approval',
        config: { approverType: 'role', approverRole: 'ops_admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-3',
      },
      {
        id: 'step-3', type: 'approval',
        config: { approverType: 'role', approverRole: 'security_admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-4',
      },
      { id: 'step-4', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'high-security',
    name: 'High Security',
    description: 'Risk-gated routing: high-risk requests need security admin + owner approval, low-risk only need a manager.',
    trigger_type: 'access_request',
    tier: 'business',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      {
        id: 'step-2', type: 'condition',
        config: { expression: "context.platformRisk === 'high'", trueBranch: 'step-3', falseBranch: 'step-5' },
        next: null,
      },
      {
        id: 'step-3', type: 'approval',
        config: { approverType: 'role', approverRole: 'security_admin', timeoutMinutes: 1440, onTimeout: 'escalate', escalateTo: 'step-4' },
        next: 'step-4',
      },
      {
        id: 'step-4', type: 'approval',
        config: { approverType: 'role', approverRole: 'owner', timeoutMinutes: 2880, onTimeout: 'auto_deny' },
        next: 'step-6',
      },
      {
        id: 'step-5', type: 'approval',
        config: { approverType: 'role', approverRole: 'ops_admin', timeoutMinutes: 240, onTimeout: 'auto_deny' },
        next: 'step-6',
      },
      { id: 'step-6', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'client-gated',
    name: 'Client-Gated',
    description: 'Client contact approves before the agency admin. Ensures client consent before granting agency access.',
    trigger_type: 'access_request',
    tier: 'business',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      {
        id: 'step-2', type: 'approval',
        config: { approverType: 'role', approverRole: 'client_contact', timeoutMinutes: 2880, onTimeout: 'auto_deny' },
        next: 'step-3',
      },
      {
        id: 'step-3', type: 'approval',
        config: { approverType: 'role', approverRole: 'admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-4',
      },
      { id: 'step-4', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'committee',
    name: 'Committee',
    description: 'Requires approval from multiple security admins. Currently implemented as sequential 2-of-2.',
    trigger_type: 'access_request',
    tier: 'business',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'access_request.created' }, next: 'step-2' },
      {
        id: 'step-2', type: 'approval',
        config: { approverType: 'role', approverRole: 'security_admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-3',
      },
      {
        id: 'step-3', type: 'approval',
        config: { approverType: 'role', approverRole: 'security_admin', timeoutMinutes: 1440, onTimeout: 'auto_deny' },
        next: 'step-4',
      },
      { id: 'step-4', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: null },
    ],
  },
  {
    key: 'auto-revoke-access',
    name: 'Auto Revoke Access',
    description:
      'Fully-automatic remediation: captures before-state then revokes access. No approval step — selected for fully_automatic policies.',
    trigger_type: 'remediation.dispatched',
    tier: 'business',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'remediation.dispatched' }, next: 'step-2' },
      { id: 'step-2', type: 'action', config: { actionType: 'capture_before_state' }, next: 'step-3' },
      { id: 'step-3', type: 'action', config: { actionType: 'revoke_access', params: {} }, next: null },
    ],
  },
  {
    key: 'semi-auto-revoke-access',
    name: 'Semi-Auto Revoke Access',
    description:
      'Semi-automatic remediation: operator approval gate before capturing state and revoking. Selected for semi_automatic policies.',
    trigger_type: 'remediation.dispatched',
    tier: 'growth',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'remediation.dispatched' }, next: 'step-2' },
      {
        id: 'step-2',
        type: 'approval',
        config: {
          approverType: 'role',
          approverRole: 'security_admin',
          timeoutMinutes: 1440,
          onTimeout: 'auto_deny',
        },
        next: 'step-3',
      },
      { id: 'step-3', type: 'action', config: { actionType: 'capture_before_state' }, next: 'step-4' },
      { id: 'step-4', type: 'action', config: { actionType: 'revoke_access', params: {} }, next: null },
    ],
  },
  {
    key: 'revert-remediation',
    name: 'Revert Remediation',
    description:
      'System workflow that undoes a completed remediation by restoring the captured before-state and re-provisioning platform access.',
    trigger_type: 'remediation.revert_requested',
    tier: 'free',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'remediation.revert_requested' }, next: 'step-2' },
      { id: 'step-2', type: 'action', config: { actionType: 'restore_before_state' }, next: 'step-3' },
      {
        id: 'step-3',
        type: 'notification',
        config: {
          channels: ['in_app'],
          templateKey: 'remediation_reverted',
          recipientType: 'role',
          recipientRole: 'security_admin',
        },
        next: null,
      },
    ],
  },
  {
    key: 'emergency',
    name: 'Emergency',
    description: 'Break-glass workflow with 15-minute timeout that auto-approves. Ensures breakglass requests are never blocked.',
    trigger_type: 'breakglass',
    tier: 'business',
    steps: [
      { id: 'step-1', type: 'trigger', config: { eventType: 'breakglass.requested' }, next: 'step-2' },
      {
        id: 'step-2', type: 'approval',
        config: { approverType: 'role', approverRole: 'security_admin', timeoutMinutes: 15, onTimeout: 'auto_approve' },
        next: 'step-3',
      },
      { id: 'step-3', type: 'action', config: { actionType: 'grant_access', params: { inherit: true } }, next: 'step-4' },
      {
        id: 'step-4', type: 'notification',
        config: { channels: ['email', 'in_app'], templateKey: 'breakglass_granted', recipientType: 'role', recipientRole: 'security_admin' },
        next: null,
      },
    ],
  },
];

// ---- Composed System Templates --------------------------------------------
//
// `SYSTEM_TEMPLATES` = central templates + every plugin's contributed
// templates (from `getAllRemediationTemplates()`). Composed once at module
// load — the registry runs its boot-time validation there, so any
// collisions / malformed namespacing / dangling handler refs throw before
// this array is built.

export const SYSTEM_TEMPLATES: SystemTemplate[] = [
  ...CENTRAL_TEMPLATES,
  ...(getAllRemediationTemplates() as unknown as SystemTemplate[]),
];

// ---- Seed Function ---------------------------------------------------------

/**
 * Seed system templates for an agency.
 * System templates have is_system = true and are scoped to each agency.
 * Skips templates that already exist for the given agency.
 */
export async function seedSystemTemplates(agencyId: string): Promise<void> {
  const { prisma } = getRuntime();

  for (const template of SYSTEM_TEMPLATES) {
    // Check if template already exists for this agency
    const existing = await prisma.workflow_definitions.findFirst({
      where: { key: template.key, is_system: true, agency_id: agencyId },
      select: { id: true },
    });

    if (existing) continue;

    await prisma.workflow_definitions.create({
      data: {
        agency_id: agencyId,
        key: template.key,
        name: template.name,
        description: template.description,
        version: 1,
        trigger_type: template.trigger_type,
        steps: template.steps as unknown as Prisma.InputJsonValue,
        is_system: true,
        is_active: true,
      },
    });
  }
}

/**
 * Get all system templates.
 */
export async function getSystemTemplates(): Promise<WorkflowDefinition[]> {
  const { prisma } = getRuntime();

  return prisma.workflow_definitions.findMany({
    where: { is_system: true },
    orderBy: { created_at: 'asc' },
  }) as unknown as Promise<WorkflowDefinition[]>;
}

/**
 * Get tier requirement for a template key.
 */
export function getTemplateTier(key: string): TemplateTier {
  const template = SYSTEM_TEMPLATES.find(t => t.key === key);
  return template?.tier || 'business';
}
