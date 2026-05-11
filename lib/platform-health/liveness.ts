/**
 * Platform Health — central liveness dispatcher (shim).
 *
 * The plugin-specific probe code now lives next to its plugin:
 *   - shared/plugins/identity/google-workspace/liveness.ts
 *   - shared/plugins/identity/entra-id/liveness.ts
 *
 * This file remains as a thin pluginKey-based dispatcher so tests and
 * any other consumer that wants the "give me the right probe for this
 * source" convenience can still call `runLivenessCheck()` without
 * knowing about each plugin. The Bull processors and the orchestrator
 * call per-plugin liveness directly — this shim is not on the hot
 * path.
 */

import type { LivenessResult } from './types.js';

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

export async function runLivenessCheck(
  source: SourceForLiveness,
): Promise<LivenessResult | undefined> {
  if (source.connectionState === 'disconnected') return undefined;

  switch (source.pluginKey) {
    case 'entra-id': {
      const { checkEntra } = await import(
        '../../plugins/identity/entra-id/liveness.js'
      );
      return checkEntra(source);
    }
    case 'google-workspace': {
      const { checkGoogleWorkspace } = await import(
        '../../plugins/identity/google-workspace/liveness.js'
      );
      return checkGoogleWorkspace(source);
    }
    default:
      return undefined;
  }
}
