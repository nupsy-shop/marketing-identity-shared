/**
 * Plugin Remediations Registry
 *
 * Resolves plugin-contributed remediation action handlers + workflow
 * templates. Identity plugins contribute a `PluginRemediationModule` from
 * `<plugin>/remediations/index.ts`; this registry imports each one
 * explicitly (mirrors the `drift-adapter-registry.ts` pattern — no dynamic
 * filesystem discovery).
 *
 * Boot-time validation (fails loudly on any violation):
 *   1. Every `actionHandlers` key matches `${pluginKey}:${actionName}`.
 *   2. No two plugins register the same action type.
 *   3. Every template step whose `config.actionType` is namespaced must
 *      reference a handler registered in the same plugin.
 *
 * Access-request primitives (`grant_access`, `revoke_access`,
 * `create_task`, `update_status`, `restore_before_state`) stay central —
 * they are workflow-engine primitives, not plugin-specific. The central
 * `action.ts` executor checks the central dict first, then falls back to
 * `getRemediationHandler()` for namespaced types.
 */

import type {
  PluginRemediationModule,
  PluginSystemTemplate,
  RemediationActionHandler,
} from './common/remediation-contract.js';
import localDirectoryRemediations from './local-directory/remediations/index.js';
import googleWorkspaceRemediations from './google-workspace/remediations/index.js';
import entraIdRemediations from './entra-id/remediations/index.js';

/** Custom error thrown on any registry validation failure. */
export class PluginRemediationRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRemediationRegistrationError';
  }
}

const NAMESPACED_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;

/**
 * Explicit plugin list. Order is not significant — the registry validates
 * all modules before exposing them. Adding a plugin = add its module here.
 */
const REGISTERED_PLUGINS: PluginRemediationModule[] = [
  localDirectoryRemediations,
  googleWorkspaceRemediations,
  entraIdRemediations,
];

interface RegistryState {
  handlersByType: Map<string, RemediationActionHandler>;
  templates: PluginSystemTemplate[];
}

let state: RegistryState | null = null;

function validateAndBuild(
  modules: PluginRemediationModule[],
): RegistryState {
  const handlersByType = new Map<string, RemediationActionHandler>();
  const templates: PluginSystemTemplate[] = [];
  const ownerByType = new Map<string, string>();

  for (const mod of modules) {
    if (!mod.pluginKey) {
      throw new PluginRemediationRegistrationError(
        'PluginRemediationModule missing pluginKey',
      );
    }

    for (const [actionType, handler] of Object.entries(mod.actionHandlers)) {
      if (!NAMESPACED_RE.test(actionType)) {
        throw new PluginRemediationRegistrationError(
          `Action type "${actionType}" from plugin "${mod.pluginKey}" is not namespaced as "<plugin-key>:<action>"`,
        );
      }
      const [ns] = actionType.split(':');
      if (ns !== mod.pluginKey) {
        throw new PluginRemediationRegistrationError(
          `Action type "${actionType}" namespace "${ns}" does not match its plugin's pluginKey "${mod.pluginKey}"`,
        );
      }
      if (ownerByType.has(actionType)) {
        throw new PluginRemediationRegistrationError(
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
        // (grant_access, revoke_access, ...) are intentionally un-namespaced.
        if (!at.includes(':')) continue;
        if (!NAMESPACED_RE.test(at)) {
          throw new PluginRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references malformed action type "${at}"`,
          );
        }
        const owner = ownerByType.get(at);
        if (!owner) {
          throw new PluginRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references unregistered action type "${at}"`,
          );
        }
        if (owner !== mod.pluginKey) {
          throw new PluginRemediationRegistrationError(
            `Template "${template.key}" (plugin "${mod.pluginKey}") step "${step.id}" references action type "${at}" owned by plugin "${owner}" — templates may only reference handlers in their own plugin`,
          );
        }
      }
      templates.push(template);
    }
  }

  return { handlersByType, templates };
}

function ensureLoaded(): RegistryState {
  if (state) return state;
  state = validateAndBuild(REGISTERED_PLUGINS);
  return state;
}

/**
 * Resolve a plugin-contributed remediation action handler by namespaced
 * action type. Returns `null` if the type is not registered (caller
 * decides whether to fail the step or fall back).
 */
export function getRemediationHandler(
  actionType: string,
): RemediationActionHandler | null {
  const s = ensureLoaded();
  return s.handlersByType.get(actionType) ?? null;
}

/** All plugin-contributed workflow templates, aggregated across plugins. */
export function getAllRemediationTemplates(): PluginSystemTemplate[] {
  const s = ensureLoaded();
  return s.templates.slice();
}

/**
 * Test-only helpers. `__resetRemediationRegistryForTests` forces the next
 * call to re-validate. `__setRemediationPluginsForTests` injects a custom
 * module list (validated) and returns a restore function.
 */
export function __resetRemediationRegistryForTests(): void {
  state = null;
}

export function __setRemediationPluginsForTests(
  modules: PluginRemediationModule[],
): () => void {
  const prev = state;
  state = validateAndBuild(modules);
  return () => {
    state = prev;
  };
}
