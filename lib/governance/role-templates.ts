/**
 * Role Templates — Assembly, Validation, and CRUD Helpers
 *
 * Role Templates map job functions (Media Buyer, Analyst, etc.) to
 * platform-specific roles. This module handles:
 * - Assembling default templates from platform manifest hints
 * - Validating template structure
 * - CRUD helpers for the JSONB column on agency_settings
 */

import crypto from 'crypto';
import type { ReferenceCounts } from './role-template-references';

// --- Types -------------------------------------------------------------------

/**
 * Reference-count summary for a Role Template. Re-uses the shape produced by
 * `countTemplateReferences` so the API and UI share a single source of truth.
 */
export type RoleTemplateReferenceInfo = ReferenceCounts;

export interface TemplateDefinition {
  key: string;
  name: string;
  description: string;
}

export interface PlatformRole {
  platformKey: string;
  platformName?: string;
  platformLogoPath?: string | null;
  platformBrandColor?: string | null;
  platformIcon?: string | null;
  accessType: string;
  roleKey: string;
  roleLabel: string;
  available?: boolean;
  reason?: string;
}

export interface RoleTemplate {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  platformRoles: PlatformRole[];
  /** Populated by GET handlers for the admin UI; absent on writes. */
  references?: RoleTemplateReferenceInfo;
}

interface AccessItemType {
  type: string;
  [key: string]: unknown;
}

interface PlatformManifest {
  platformKey?: string;
  key?: string;
  displayName?: string;
  name?: string;
  logoPath?: string | null;
  brandColor?: string | null;
  icon?: string | null;
  roleTemplateHints?: Record<string, string>;
  supportedAccessItemTypes?: (string | AccessItemType)[];
  [key: string]: unknown;
}

interface ConnectedPlatform {
  manifest?: PlatformManifest;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// --- Template Definitions ----------------------------------------------------

export const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  { key: 'media-buyer', name: 'Media Buyer', description: 'Manages ad campaigns and media spend' },
  { key: 'analyst', name: 'Analyst', description: 'Read-only analytics and reporting access' },
  { key: 'account-manager', name: 'Account Manager', description: 'Manages platform configuration and client settings' },
  { key: 'agency-admin', name: 'Agency Admin', description: 'Full administrative access across all platforms' },
  { key: 'content-creator', name: 'Content Creator', description: 'Creates and publishes content, read access to analytics' },
];

// --- Assembly ----------------------------------------------------------------

/**
 * Assemble default Role Templates from connected platform manifests.
 * Only includes platforms that the agency has connected.
 */
export function assembleTemplatesFromPlugins(connectedPlatforms: ConnectedPlatform[]): RoleTemplate[] {
  return TEMPLATE_DEFINITIONS.map(def => {
    const platformRoles: PlatformRole[] = [];

    for (const platform of connectedPlatforms) {
      const manifest: PlatformManifest = (platform.manifest || platform) as PlatformManifest;
      const hints = manifest.roleTemplateHints || {};
      const hintedRole = hints[def.key];

      if (!hintedRole) continue;

      // Determine the default access type for this platform
      const accessItemTypes = manifest.supportedAccessItemTypes || [];
      const firstItem = accessItemTypes.length > 0 ? accessItemTypes[0] : undefined;
      const defaultAccessType = firstItem
        ? (typeof firstItem === 'object' ? (firstItem as AccessItemType).type : firstItem)
        : 'NAMED_INVITE';

      platformRoles.push({
        platformKey: manifest.platformKey || manifest.key || '',
        platformName: manifest.displayName || manifest.name || manifest.platformKey || '',
        platformLogoPath: manifest.logoPath || null,
        platformBrandColor: manifest.brandColor || null,
        platformIcon: manifest.icon || null,
        accessType: defaultAccessType,
        roleKey: hintedRole,
        roleLabel: hintedRole.charAt(0).toUpperCase() + hintedRole.slice(1),
      });
    }

    return {
      id: crypto.randomUUID(),
      key: def.key,
      name: def.name,
      description: def.description,
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      platformRoles,
    };
  });
}

// --- Validation --------------------------------------------------------------

const MAX_TEMPLATES = 50;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Validate a role template object.
 */
export function validateTemplate(
  template: Partial<RoleTemplate>,
  existingTemplates: RoleTemplate[] = [],
  excludeId: string | null = null,
): ValidationResult {
  const errors: string[] = [];

  // Name validation
  if (!template.name || typeof template.name !== 'string' || template.name.trim().length === 0) {
    errors.push('Name is required');
  } else if (template.name.length > MAX_NAME_LENGTH) {
    errors.push(`Name must be at most ${MAX_NAME_LENGTH} characters`);
  }

  // Key validation
  if (!template.key || typeof template.key !== 'string' || template.key.trim().length === 0) {
    errors.push('Key is required');
  } else if (!/^[a-z0-9-]+$/.test(template.key)) {
    errors.push('Key must be kebab-case (lowercase letters, numbers, and hyphens)');
  }

  // Description validation
  if (template.description && template.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  // Uniqueness check
  const others = existingTemplates.filter(t => t.id !== excludeId);
  if (template.key && others.some(t => t.key === template.key)) {
    errors.push(`Template key '${template.key}' already exists`);
  }

  // Max templates check
  if (!excludeId && existingTemplates.length >= MAX_TEMPLATES) {
    errors.push(`Maximum of ${MAX_TEMPLATES} templates per agency`);
  }

  // Platform roles validation
  if (template.platformRoles && Array.isArray(template.platformRoles)) {
    const seen = new Set<string>();
    for (const pr of template.platformRoles) {
      if (!pr.platformKey) {
        errors.push('Each platform role must have a platformKey');
      }
      if (!pr.accessType) {
        errors.push('Each platform role must have an accessType');
      }
      if (!pr.roleKey) {
        errors.push('Each platform role must have a roleKey');
      }
      const pairKey = `${pr.platformKey}:${pr.accessType}`;
      if (seen.has(pairKey)) {
        errors.push(`Duplicate platform+accessType pair: ${pr.platformKey} / ${pr.accessType}`);
      }
      seen.add(pairKey);
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- CRUD Helpers ------------------------------------------------------------

interface CreateTemplateData {
  key: string;
  name: string;
  description?: string;
  platformRoles?: Pick<PlatformRole, 'platformKey' | 'accessType' | 'roleKey' | 'roleLabel'>[];
}

interface UpdateTemplateData {
  name?: string;
  description?: string;
  isActive?: boolean;
  platformRoles?: Pick<PlatformRole, 'platformKey' | 'accessType' | 'roleKey' | 'roleLabel'>[];
}

/**
 * Create a new template and return the updated templates array.
 */
export function createTemplate(
  existingTemplates: RoleTemplate[],
  data: CreateTemplateData,
): { template: RoleTemplate; templates: RoleTemplate[] } {
  const now = new Date().toISOString();
  const template: RoleTemplate = {
    id: crypto.randomUUID(),
    key: data.key,
    name: data.name,
    description: data.description || '',
    isDefault: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    platformRoles: (data.platformRoles || []).map(pr => ({
      platformKey: pr.platformKey,
      accessType: pr.accessType,
      roleKey: pr.roleKey,
      roleLabel: pr.roleLabel || pr.roleKey,
    })),
  };

  const templates = [...existingTemplates, template];
  return { template, templates };
}

/**
 * Update an existing template and return the updated templates array.
 */
export function updateTemplate(
  existingTemplates: RoleTemplate[],
  templateId: string,
  data: UpdateTemplateData,
): { template: RoleTemplate; templates: RoleTemplate[] } | null {
  const idx = existingTemplates.findIndex(t => t.id === templateId);
  if (idx === -1) return null;

  const existing = existingTemplates[idx];
  const now = new Date().toISOString();

  const updated: RoleTemplate = {
    ...existing,
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.isActive !== undefined && { isActive: data.isActive }),
    ...(data.platformRoles !== undefined && {
      platformRoles: data.platformRoles.map(pr => ({
        platformKey: pr.platformKey,
        accessType: pr.accessType,
        roleKey: pr.roleKey,
        roleLabel: pr.roleLabel || pr.roleKey,
      })),
    }),
    updatedAt: now,
    // If a default template is modified, mark it as non-default
    isDefault: data.platformRoles !== undefined ? false : existing.isDefault,
  };

  const templates = [...existingTemplates];
  templates[idx] = updated;
  return { template: updated, templates };
}

/**
 * Delete a template and return the updated templates array.
 */
export function deleteTemplate(
  existingTemplates: RoleTemplate[],
  templateId: string,
): { templates: RoleTemplate[] } | null {
  const idx = existingTemplates.findIndex(t => t.id === templateId);
  if (idx === -1) return null;

  const templates = existingTemplates.filter(t => t.id !== templateId);
  return { templates };
}

/**
 * Resolve a role template's platform roles for a specific client.
 * Filters to only platforms connected to the client.
 */
export function resolveTemplateForClient(
  template: RoleTemplate,
  clientPlatformKeys: string[],
): { available: PlatformRole[]; unavailable: PlatformRole[] } {
  const clientKeySet = new Set(clientPlatformKeys);
  const available: PlatformRole[] = [];
  const unavailable: PlatformRole[] = [];

  for (const pr of template.platformRoles || []) {
    if (clientKeySet.has(pr.platformKey)) {
      available.push({ ...pr, available: true });
    } else {
      unavailable.push({
        ...pr,
        available: false,
        reason: 'Platform not connected to this client',
      });
    }
  }

  return { available, unavailable };
}

/**
 * Generate a kebab-case key from a display name.
 */
export function nameToKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
