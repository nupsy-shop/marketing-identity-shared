/**
 * Platform Plugin Remediations Registry
 *
 * Resolves platform-plugin-contributed remediation workflow templates.
 * Platform plugins contribute a `PluginRemediationModule` from
 * `<plugin>/remediations/index.ts`; this registry imports each one
 * explicitly (mirrors the identity `remediations-registry.ts` pattern).
 *
 * Validation rules (subset of identity registry):
 *   1. Every `actionHandlers` key (if any) matches `${pluginKey}:${actionName}`.
 *   2. No two plugins register the same action type.
 *   3. Namespaced step `actionType` references in templates must be owned by
 *      the same plugin. Un-namespaced types (e.g. `flag_platform_audit_event`,
 *      `grant_access`) are central workflow-engine primitives — skipped here.
 *
 * Platform plugins typically DON'T register custom action handlers today —
 * they reuse the central `flag_platform_audit_event` primitive. The
 * `actionHandlers` map is expected to be empty for most platform modules
 * in this initial release. Follow-up PRs per platform add namespaced handlers.
 *
 * Templates are merged into `SYSTEM_TEMPLATES` at boot (see
 * `shared/lib/workflows/templates.ts`), seeded per-agency by
 * `seedSystemTemplates`.
 */

import type {
  PluginRemediationModule,
  PluginSystemTemplate,
  RemediationActionHandler,
} from '../identity/common/remediation-contract.js';
import ga4Remediations from './ga4/remediations/index.js';
import googleAdsRemediations from './google-ads/remediations/index.js';
import gtmRemediations from './gtm/remediations/index.js';
import hubspotRemediations from './hubspot/remediations/index.js';
import metaRemediations from './meta/remediations/index.js';
import salesforceRemediations from './salesforce/remediations/index.js';

/** Custom error thrown on any registry validation failure. */
export class PlatformRemediationRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformRemediationRegistrationError';
  }
}

const NAMESPACED_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;

/**
 * Explicit platform plugin list.
 * Adding a new platform = add its module here.
 * Only platforms with audit adapters need to be listed (currently: ga4,
 * google-ads, gtm, hubspot, meta, salesforce — others added in follow-up PRs
 * as they register per-platform templates).
 */
const REGISTERED_PLATFORM_PLUGINS: PluginRemediationModule[] = [
  ga4Remediations,
  googleAdsRemediations,
  gtmRemediations,
  hubspotRemediations,
  metaRemediations,
  salesforceRemediations,
];

interface PlatformRegistryState {
  handlersByType: Map<string, RemediationActionHandler>;
  templates: PluginSystemTemplate[];
}

let state: PlatformRegistryState | null = null;

function validateAndBuild(
  modules: PluginRemediationModule[],
): PlatformRegistryState {
  const handlersByType = new Map<string, RemediationActionHandler>();
  const templates: PluginSystemTemplate[] = [];
  const ownerByType = new Map<string, string>();

  for (const mod of modules) {
    if (!mod.pluginKey) {
      throw new PlatformRemediationRegistrationError(
        'PluginRemediationModule missing pluginKey',
      );
    }

    for (const [actionType, handler] of Object.entries(mod.actionHandlers)) {
      if (!NAMESPACED_RE.test(actionType)) {
        throw new PlatformRemediationRegistrationError(
          `Action type "${actionType}" from plugin "${mod.pluginKey}" is not namespaced as "<plugin-key>:<action>"`,
        );
      }
      const [ns] = actionType.split(':');
      if (ns !== mod.pluginKey) {
        throw new PlatformRemediationRegistrationError(
          `Action type "${actionType}" namespace "${ns}" does not match its plugin's pluginKey "${mod.pluginKey}"`,
        );
      }
      if (ownerByType.has(actionType)) {
        throw new PlatformRemediationRegistrationError(
          `Duplicate remediation action type "${actionType}" — registered by both "${ownerByType.get(actionType)}" and "${mod.pluginKey}"`,
        );
      }
      ownerByType.set(actionType, mod.pluginKey);
      handlersByType.set(actionType, handler);
    }
  }

  for (const mod of modules) {
    for (const template of mod.templates) {
      for (const step of template.steps) {
        const cfg = (step.config || {}) as { actionType?: unknown };
        if (typeof cfg.actionType !== 'string') continue;
        const at = cfg.actionType;
        // Only validate namespaced types; central primitives
        // (flag_platform_audit_event, grant_access, revoke_access, ...) are
        // intentionally un-namespaced and are skipped here.
        if (!at.includes(':')) continue;
        if (!NAMESPACED_RE.test(at)) {
          throw new PlatformRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references malformed action type "${at}"`,
          );
        }
        const owner = ownerByType.get(at);
        if (!owner) {
          throw new PlatformRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references unregistered action type "${at}"`,
          );
        }
        if (owner !== mod.pluginKey) {
          throw new PlatformRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references action type "${at}" owned by plugin "${owner}" — templates may only reference handlers in their own plugin`,
          );
        }
      }
      templates.push(template);
    }
  }

  return { handlersByType, templates };
}

function ensureLoaded(): PlatformRegistryState {
  if (state) return state;
  state = validateAndBuild(REGISTERED_PLATFORM_PLUGINS);
  return state;
}

/**
 * Resolve a platform-plugin-contributed remediation action handler by namespaced
 * action type. Returns `null` if the type is not registered.
 */
export function getPlatformRemediationHandler(
  actionType: string,
): RemediationActionHandler | null {
  const s = ensureLoaded();
  return s.handlersByType.get(actionType) ?? null;
}

/** All platform-plugin-contributed workflow templates, aggregated across plugins. */
export function getAllPlatformRemediationTemplates(): PluginSystemTemplate[] {
  const s = ensureLoaded();
  return s.templates.slice();
}

/**
 * Test-only helpers.
 */
export function __resetPlatformRemediationRegistryForTests(): void {
  state = null;
}

export function __setPlatformPluginsForTests(
  modules: PluginRemediationModule[],
): () => void {
  const prev = state;
  state = validateAndBuild(modules);
  return () => {
    state = prev;
  };
}
