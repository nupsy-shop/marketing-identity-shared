export default {
  gws_create_user: () => import('./gws-create-user.js'),
  gws_suspend_user: () => import('./gws-suspend-user.js'),
  gws_sync_directory: () => import('./gws-sync-directory.js'),
};

// Max concurrent jobs per tenant for each job type.
// Google Admin SDK has strict rate limits — parallel gws_create_user
// calls trigger 403 "Rate Limit Exceeded" errors and cascade failures.
export const concurrency = {
  gws_create_user: 1,
  gws_suspend_user: 1,
  gws_sync_directory: 1,
};
