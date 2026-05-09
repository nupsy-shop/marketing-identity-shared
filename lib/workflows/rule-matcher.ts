/**
 * Workflow Rule Matcher
 *
 * Evaluates assignment rules to determine which workflow definition
 * handles a given trigger event. Rules are stored in agency_settings.workflow_rules
 * and evaluated top-down — first match wins.
 */

import { getRuntime } from '../runtime.js';
import type { WorkflowDefinition } from './types.js';

interface MatchCondition {
  default?: boolean;
  triggerType?: string;
  [field: string]: unknown;
}

interface WorkflowRule {
  match: MatchCondition;
  workflowKey: string;
}

interface WorkflowRulesSettings {
  rules?: WorkflowRule[];
}

interface AgencySettingsShape {
  workflowRules?: WorkflowRulesSettings;
  defaultApprovalMode?: string;
  [key: string]: unknown;
}

/**
 * Match a workflow definition for a trigger event.
 *
 * @param agencyId - The agency UUID
 * @param triggerType - The trigger type (access_request, breakglass, etc.)
 * @param context - The trigger context data
 * @returns The matched workflow definition, or null if none found
 */
export async function matchWorkflow(
  agencyId: string,
  triggerType: string,
  context: Record<string, unknown>,
): Promise<WorkflowDefinition | null> {
  const { prisma } = getRuntime();

  const row = await prisma.agency_settings.findFirst({
    where: { agency_id: agencyId },
    select: { workflow_rules: true, default_approval_mode: true },
  });

  const settings: AgencySettingsShape | null = row
    ? {
        workflowRules: (row.workflow_rules as WorkflowRulesSettings | null) ?? undefined,
        defaultApprovalMode: row.default_approval_mode ?? undefined,
      }
    : null;

  const rules = settings?.workflowRules?.rules;

  if (rules && Array.isArray(rules) && rules.length > 0) {
    // Evaluate rules top-down, first match wins
    for (const rule of rules) {
      if (matchesRule(rule.match, triggerType, context)) {
        const definition = await findDefinition(agencyId, rule.workflowKey);
        if (definition) return definition;
      }
    }
  }

  // Fallback: drift events route by (sourcePluginKey, principalType) to
  // the plugin-owned template. Other triggers fall through to
  // default_approval_mode.
  if (triggerType === 'drift.detected') {
    const driftKey = resolveDriftTemplateKey(context);
    if (driftKey) {
      const def = await findDefinition(agencyId, driftKey);
      if (def) return def;
    }
    return null;
  }

  const legacyKey = mapLegacyApprovalMode(settings?.defaultApprovalMode, triggerType);
  if (legacyKey) {
    const definition = await findDefinition(agencyId, legacyKey);
    if (definition) return definition;
  }

  return null;
}

/**
 * Default drift-template mapping (issues #90, #89, identity_missing, identity_inactive).
 * Matches the autonomy matrix:
 *   - Local Directory + identity               → link-keycloak-identity
 *   - GW/Entra + synthetic_identity            → recreate-*-synthetic-identity
 *   - GW/Entra + identity + identity_missing   → flag-missing-*-identity
 *   - GW/Entra + identity + identity_inactive  → flag-inactive-*-identity
 *
 * Users on GW/Entra are filtered by the autonomy matrix before we're called
 * (JML owns them).
 */
function resolveDriftTemplateKey(context: Record<string, unknown>): string | null {
  const pluginKey = context.sourcePluginKey as string | undefined;
  const principalType = context.principalType as string | undefined;
  const driftType = context.driftType as string | undefined;

  if (pluginKey === 'local-directory') return 'drift-link-keycloak-identity';

  if (pluginKey === 'google-workspace' && principalType === 'synthetic_identity') {
    return 'drift-recreate-gws-synthetic-identity';
  }
  if (pluginKey === 'entra-id' && principalType === 'synthetic_identity') {
    return 'drift-recreate-entra-synthetic-identity';
  }

  if (
    pluginKey === 'google-workspace' &&
    principalType === 'identity' &&
    driftType === 'identity_missing'
  ) {
    return 'drift-flag-missing-gws-identity';
  }
  if (
    pluginKey === 'entra-id' &&
    principalType === 'identity' &&
    driftType === 'identity_missing'
  ) {
    return 'drift-flag-missing-entra-identity';
  }

  if (
    pluginKey === 'google-workspace' &&
    principalType === 'identity' &&
    driftType === 'identity_inactive'
  ) {
    return 'drift-flag-inactive-gws-identity';
  }
  if (
    pluginKey === 'entra-id' &&
    principalType === 'identity' &&
    driftType === 'identity_inactive'
  ) {
    return 'drift-flag-inactive-entra-identity';
  }

  return null;
}

/**
 * Check if a rule's match conditions are satisfied.
 */
function matchesRule(
  match: MatchCondition | undefined,
  triggerType: string,
  context: Record<string, unknown>,
): boolean {
  if (!match || typeof match !== 'object') return false;

  // Default catch-all
  if (match.default === true) return true;

  // All fields in match must be satisfied (AND logic)
  for (const [field, value] of Object.entries(match)) {
    if (field === 'default') continue;

    if (field === 'triggerType') {
      if (triggerType !== value) return false;
      continue;
    }

    // Check context fields
    if (context?.[field] !== value) return false;
  }

  return true;
}

/**
 * Map legacy default_approval_mode to a workflow template key.
 */
function mapLegacyApprovalMode(mode: string | undefined, triggerType: string): string {
  if (triggerType === 'breakglass') return 'emergency';
  // Drift events are handled above by `resolveDriftTemplateKey` — this
  // helper only covers non-drift fallbacks now.

  switch (mode) {
    case 'single': return 'standard';
    case 'dual': return 'dual-approval';
    default: return 'auto-approve';
  }
}

/**
 * Find a workflow definition by key, checking agency-scoped first, then system.
 */
async function findDefinition(
  agencyId: string,
  workflowKey: string,
): Promise<WorkflowDefinition | null> {
  const { prisma } = getRuntime();

  // Check agency-scoped first
  const agencyResult = await prisma.workflow_definitions.findFirst({
    where: { key: workflowKey, agency_id: agencyId, is_active: true },
  });
  if (agencyResult) return agencyResult as unknown as WorkflowDefinition;

  // Fall back to system template
  const systemResult = await prisma.workflow_definitions.findFirst({
    where: { key: workflowKey, is_system: true, is_active: true },
  });
  if (systemResult) return systemResult as unknown as WorkflowDefinition;

  return null;
}
