/**
 * Mover Detector — Shared Library
 *
 * Cross-references group membership changes and attribute (department/title)
 * changes against client_group_bindings and policy attribute_mappings to
 * detect client-level transitions (departure from Client A, arrival at Client B).
 *
 * Two strategies:
 * A) Group-based: group change → client_group_bindings lookup → client transition
 * B) Attribute-based: department/title change → attribute_mappings lookup → client transition
 *
 * When both departure + arrival are detected for the same user in the same sync,
 * this is an atomic mover event.
 */

import { getRuntime } from '../runtime.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GroupChange {
  userExternalId: string;
  userEmail: string;
  added: string[];    // group external IDs or DB IDs
  removed: string[];  // group external IDs or DB IDs
}

export interface AttributeChange {
  userExternalId: string;
  userEmail: string;
  attribute: 'department' | 'job_title';
  oldValue: string | null;
  newValue: string | null;
}

export interface AttributeMapping {
  attribute: 'department' | 'title';
  value?: string;
  pattern?: string;
  client_id: string;
}

export interface ClientTransition {
  userExternalId: string;
  userEmail: string;
  departures: ClientDeparture[];
  arrivals: ClientArrival[];
  isAtomicSwap: boolean;
  detectedBy: 'group' | 'attribute' | 'both';
}

export interface ClientDeparture {
  clientId: string;
  clientName?: string;
  reason: 'group_removed' | 'attribute_changed';
  groupId?: string;
  groupName?: string;
  oldAttribute?: string;
}

export interface ClientArrival {
  clientId: string;
  clientName?: string;
  reason: 'group_added' | 'attribute_changed';
  groupId?: string;
  groupName?: string;
  newAttribute?: string;
}

export interface MoverDetectionResult {
  transitions: ClientTransition[];
  unmatchedGroupChanges: GroupChange[];
  unmatchedAttributeChanges: AttributeChange[];
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect client-level mover transitions from group and attribute changes.
 */
export async function detectMoverTransitions(
  agencyId: string,
  sourceId: string,
  groupChanges: GroupChange[],
  attributeChanges: AttributeChange[],
  attributeMappings: AttributeMapping[],
): Promise<MoverDetectionResult> {
  const { prisma } = getRuntime();

  const transitionsByUser = new Map<string, { departures: ClientDeparture[]; arrivals: ClientArrival[]; detectedBy: Set<string> }>();
  const unmatchedGroupChanges: GroupChange[] = [];
  const unmatchedAttributeChanges: AttributeChange[] = [];

  // ─── Strategy A: Group-Based Detection ─────────────────────────────

  for (const change of groupChanges) {
    let matched = false;

    // Check removed groups against client_group_bindings
    for (const groupId of change.removed) {
      const binding = await prisma.client_group_bindings?.findFirst({
        where: {
          directory_group_id: groupId,
          agency_id: agencyId,
          is_active: true,
        },
        select: { client_id: true, clients: { select: { name: true } } },
      }).catch(() => null);

      if (binding) {
        matched = true;
        const entry = getOrCreateEntry(transitionsByUser, change.userExternalId);
        entry.departures.push({
          clientId: binding.client_id,
          clientName: (binding as any).clients?.name,
          reason: 'group_removed',
          groupId,
        });
        entry.detectedBy.add('group');
      }
    }

    // Check added groups against client_group_bindings
    for (const groupId of change.added) {
      const binding = await prisma.client_group_bindings?.findFirst({
        where: {
          directory_group_id: groupId,
          agency_id: agencyId,
          is_active: true,
        },
        select: { client_id: true, clients: { select: { name: true } } },
      }).catch(() => null);

      if (binding) {
        matched = true;
        const entry = getOrCreateEntry(transitionsByUser, change.userExternalId);
        entry.arrivals.push({
          clientId: binding.client_id,
          clientName: (binding as any).clients?.name,
          reason: 'group_added',
          groupId,
        });
        entry.detectedBy.add('group');
      }
    }

    if (!matched) unmatchedGroupChanges.push(change);
  }

  // ─── Strategy B: Attribute-Based Detection ─────────────────────────

  for (const change of attributeChanges) {
    let matched = false;

    // Find mappings for old value → departure
    const oldMappings = findMatchingMappings(attributeMappings, change.attribute, change.oldValue);
    for (const mapping of oldMappings) {
      matched = true;
      const entry = getOrCreateEntry(transitionsByUser, change.userExternalId);
      entry.departures.push({
        clientId: mapping.client_id,
        reason: 'attribute_changed',
        oldAttribute: `${change.attribute}: ${change.oldValue}`,
      });
      entry.detectedBy.add('attribute');
    }

    // Find mappings for new value → arrival
    const newMappings = findMatchingMappings(attributeMappings, change.attribute, change.newValue);
    for (const mapping of newMappings) {
      matched = true;
      const entry = getOrCreateEntry(transitionsByUser, change.userExternalId);
      entry.arrivals.push({
        clientId: mapping.client_id,
        reason: 'attribute_changed',
        newAttribute: `${change.attribute}: ${change.newValue}`,
      });
      entry.detectedBy.add('attribute');
    }

    if (!matched) unmatchedAttributeChanges.push(change);
  }

  // ─── Build transitions ─────────────────────────────────────────────

  const transitions: ClientTransition[] = [];
  for (const [userExternalId, entry] of transitionsByUser) {
    // Find email from group or attribute changes
    const email = groupChanges.find((g) => g.userExternalId === userExternalId)?.userEmail
      || attributeChanges.find((a) => a.userExternalId === userExternalId)?.userEmail
      || '';

    transitions.push({
      userExternalId,
      userEmail: email,
      departures: entry.departures,
      arrivals: entry.arrivals,
      isAtomicSwap: entry.departures.length > 0 && entry.arrivals.length > 0,
      detectedBy: entry.detectedBy.size > 1 ? 'both' : (entry.detectedBy.values().next().value as 'group' | 'attribute'),
    });
  }

  return { transitions, unmatchedGroupChanges, unmatchedAttributeChanges };
}

// ─── Coverage Analysis ──────────────────────────────────────────────────────

export interface CoverageResult {
  coveredClients: { clientId: string; clientName: string; coveredBy: 'group' | 'attribute' | 'both' }[];
  uncoveredClients: { clientId: string; clientName: string }[];
}

/**
 * Analyze which clients have automated mover detection coverage.
 */
export async function analyzeMoverCoverage(
  agencyId: string,
  sourceId: string,
  attributeMappings: AttributeMapping[],
): Promise<CoverageResult> {
  const { prisma } = getRuntime();

  // Get all clients for the agency
  const clients = await prisma.clients.findMany({
    where: { agency_id: agencyId },
    select: { id: true, name: true },
  });

  // Get clients with group bindings from SoT source groups
  const groupBindings = await prisma.client_group_bindings?.findMany({
    where: { agency_id: agencyId, is_active: true },
    select: { client_id: true, directory_group_id: true },
  }).catch(() => []) || [];

  // Check which bound groups belong to SoT source
  const sotGroups = await prisma.directory_groups.findMany({
    where: { source_id: sourceId },
    select: { id: true },
  });
  const sotGroupIds = new Set(sotGroups.map((g: any) => g.id));

  const groupCoveredClientIds = new Set(
    groupBindings
      .filter((b: any) => sotGroupIds.has(b.directory_group_id))
      .map((b: any) => b.client_id),
  );

  // Check which clients have attribute mappings
  const attrCoveredClientIds = new Set(
    attributeMappings.map((m) => m.client_id),
  );

  const coveredClients: CoverageResult['coveredClients'] = [];
  const uncoveredClients: CoverageResult['uncoveredClients'] = [];

  for (const client of clients) {
    const hasGroup = groupCoveredClientIds.has(client.id);
    const hasAttr = attrCoveredClientIds.has(client.id);

    if (hasGroup || hasAttr) {
      coveredClients.push({
        clientId: client.id,
        clientName: client.name,
        coveredBy: hasGroup && hasAttr ? 'both' : hasGroup ? 'group' : 'attribute',
      });
    } else {
      uncoveredClients.push({ clientId: client.id, clientName: client.name });
    }
  }

  return { coveredClients, uncoveredClients };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getOrCreateEntry(map: Map<string, any>, key: string) {
  if (!map.has(key)) {
    map.set(key, { departures: [], arrivals: [], detectedBy: new Set() });
  }
  return map.get(key)!;
}

function findMatchingMappings(
  mappings: AttributeMapping[],
  attribute: string,
  value: string | null,
): AttributeMapping[] {
  if (!value) return [];

  // Normalize attribute name (department vs department, title vs job_title)
  const normalizedAttr = attribute === 'job_title' ? 'title' : attribute;

  return mappings.filter((m) => {
    if (m.attribute !== normalizedAttr) return false;

    // Exact match
    if (m.value && m.value.toLowerCase() === value.toLowerCase()) return true;

    // Pattern match (glob-style)
    if (m.pattern) {
      const regex = new RegExp(
        '^' + m.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i',
      );
      return regex.test(value);
    }

    return false;
  });
}
