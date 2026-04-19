/**
 * Platform Health — state-change notification debounce.
 *
 * A "flap" is a state transition that reverses within a short window
 * (e.g. connected → error → connected in 3 minutes). We want ONE
 * notification per *effective* transition, not one per flap edge.
 *
 * Strategy: consult the audit log, not a separate in-memory state
 * machine. If the source has already emitted an
 * `identity.source.state_change` event within `DEBOUNCE_WINDOW_MS`
 * that landed on the same `newState`, coalesce.
 *
 * The debounce check is pure over its `recentTransitions` input so it
 * can be unit-tested without ES or a clock.
 */

import { DEBOUNCE_WINDOW_MS } from './types.js';

export interface RecentTransition {
  /** When the previous state_change event was emitted. */
  emittedAt: Date;
  /** The new state recorded by that event. */
  newState: string;
}

export interface DebounceInput {
  now: Date;
  newState: string;
  previousState: string | null;
  recentTransitions: RecentTransition[];
  /** Override the default window for tests. */
  windowMs?: number;
}

export interface DebounceDecision {
  shouldNotify: boolean;
  reason: string;
}

export function decideNotify(input: DebounceInput): DebounceDecision {
  const window = input.windowMs ?? DEBOUNCE_WINDOW_MS;

  if (input.newState === input.previousState) {
    return { shouldNotify: false, reason: 'no transition' };
  }

  const cutoff = input.now.getTime() - window;
  const recent = input.recentTransitions.find(
    (t) => t.newState === input.newState && t.emittedAt.getTime() >= cutoff,
  );
  if (recent) {
    return {
      shouldNotify: false,
      reason: `debounced: prior ${input.newState} at ${recent.emittedAt.toISOString()} within ${window}ms window`,
    };
  }

  return { shouldNotify: true, reason: 'state transition outside debounce window' };
}
