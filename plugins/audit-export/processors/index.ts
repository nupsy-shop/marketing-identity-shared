export default {
  audit_export_run: () => import('./run-export.js'),
};

// Concurrency is bounded — exports are cheap individually but the
// `audit.query` limit (100k rows) plus MinIO PUT can be RAM-heavy.
// 3 in flight per dyno matches the spec.
export const concurrency = {
  audit_export_run: 3,
};
