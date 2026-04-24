/**
 * Finder stub: SoD violation. Real producer tracked as a separate card; the
 * UI renders a "Detector not yet wired" badge for this trigger type. Returns
 * `[]` so the evaluation loop stays exhaustive.
 */

import type { Finder } from '../remediation-types.js';

export const sodViolationFinder: Finder = async () => [];
