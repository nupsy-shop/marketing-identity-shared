export default {
  audit_retention_sweep: () => import('./retention-sweep.js'),
};

// One sweep at a time across the worker, agencies iterated in series.
export const concurrency = {
  audit_retention_sweep: 1,
};
