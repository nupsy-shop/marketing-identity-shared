/**
 * Finder stub: over-provisioned. Risk-score integration is tracked as a
 * separate card; returns `[]` today to keep the evaluation loop exhaustive.
 */

import type { Finder } from '../remediation-types.js';

export const overProvisionedFinder: Finder = async () => [];
