/**
 * Plugin Remediation Contract
 *
 * Interface that identity plugins implement to contribute remediation
 * action handlers + workflow templates to the central workflow engine.
 *
 * Plugins export a `PluginRemediationModule` from
 * `shared/plugins/identity/<plugin-key>/remediations/index.ts`. The
 * `remediations-registry.ts` module imports each plugin's module at boot,
 * validates namespacing / collisions / template-handler references, then
 * exposes resolver functions to the workflow engine.
 *
 * Action types are namespaced as `${pluginKey}:${actionName}` — for example
 * `local-directory:link_keycloak_identity`. Namespacing prevents collisions
 * and makes template steps self-describing.
 *
 * These interfaces are structurally compatible with the host workflow
 * engine's `StepDefinition` / `WorkflowContext` / `WorkflowInstance` /
 * `StepExecutionResult` types but are re-declared here so the shared
 * submodule does not depend on the host workflow tree.
 */

/** Runtime context threaded through step executions. */
export interface PluginWorkflowContext {
  trigger?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Minimal shape of a workflow instance row. */
export interface PluginWorkflowInstance {
  id: string;
  agency_id: string;
  [key: string]: unknown;
}

/** Result returned by a remediation action handler. */
export interface PluginActionResult {
  actionCompleted: boolean;
  actionType: string;
  executedAt: string;
  [key: string]: unknown;
}

/** A remediation action handler function. */
export type RemediationActionHandler = (
  params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
) => Promise<PluginActionResult>;

/** Template tier level (mirrors host `TemplateTier`). */
export type PluginTemplateTier = 'free' | 'starter' | 'growth' | 'business';

/** A single step inside a workflow template (mirrors host `StepDefinition`). */
export interface PluginStepDefinition {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  next?: string | null;
}

/** A plugin-contributed system workflow template. */
export interface PluginSystemTemplate {
  key: string;
  name: string;
  description: string;
  trigger_type: string;
  tier: PluginTemplateTier;
  steps: PluginStepDefinition[];
}

/**
 * What each identity plugin's `remediations/index.ts` exports.
 *
 * - `pluginKey` — plugin identifier (e.g. `local-directory`). Every
 *   `actionHandlers` key and every template-step `actionType` must use
 *   `${pluginKey}:${actionName}` — enforced at boot.
 * - `actionHandlers` — map of namespaced action types to handler functions.
 * - `templates` — workflow templates that reference this plugin's handlers.
 *   Any template step whose `config.actionType` is namespaced must refer to
 *   a handler registered in the same plugin — enforced at boot.
 */
export interface PluginRemediationModule {
  pluginKey: string;
  actionHandlers: Record<string, RemediationActionHandler>;
  templates: PluginSystemTemplate[];
}
