/**
 * DriftAdapterRegistry
 *
 * Resolves an identity plugin's drift adapter from its plugin_key. Each
 * adapter is imported at module load time and registered in a module-scope
 * map. Orchestrators in lib/identity/drift/* call `getDriftAdapter(pluginKey)`
 * and delegate all provider-specific work to the returned adapter.
 *
 * `__setDriftAdapterForTests` is a test-only seam so orchestrator tests can
 * inject fakes without mocking Prisma.
 *
 * Lives in the shared submodule so the Bull worker can consume it. Web-tree
 * code re-exports from this module.
 */

import type { IdentityDriftAdapter } from './common/drift-adapter.interface.js';
import { gwsDriftAdapter } from './google-workspace/drift-adapter.js';
import { entraDriftAdapter } from './entra-id/drift-adapter.js';

export class UnsupportedPluginError extends Error {
  constructor(pluginKey: string) {
    super(`Unsupported plugin_key for drift computation: ${pluginKey}`);
    this.name = 'UnsupportedPluginError';
  }
}

const adapters = new Map<string, IdentityDriftAdapter>([
  ['google-workspace', gwsDriftAdapter],
  ['entra-id', entraDriftAdapter],
]);

export function getDriftAdapter(pluginKey: string): IdentityDriftAdapter {
  const adapter = adapters.get(pluginKey);
  if (!adapter) throw new UnsupportedPluginError(pluginKey);
  return adapter;
}

/**
 * Test-only helper. Replaces the adapter for a given plugin_key and returns
 * a restore function that puts the previous adapter back.
 */
export function __setDriftAdapterForTests(
  pluginKey: string,
  adapter: IdentityDriftAdapter,
): () => void {
  const prev = adapters.get(pluginKey);
  adapters.set(pluginKey, adapter);
  return () => {
    if (prev) adapters.set(pluginKey, prev);
    else adapters.delete(pluginKey);
  };
}
