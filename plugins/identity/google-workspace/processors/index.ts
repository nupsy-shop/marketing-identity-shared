export default {
  gws_create_user: () => import('./gws-create-user.js'),
  gws_suspend_user: () => import('./gws-suspend-user.js'),
  gws_sync_directory: () => import('./gws-sync-directory.js'),
  gws_poll_audit: () => import('./gws-poll-audit.js'),
  gws_add_group_member: () => import('./gws-add-group-member.js'),
  gws_remove_group_member: () => import('./gws-remove-group-member.js'),
  gws_disconnect: () => import('./gws-disconnect.js'),
};

// Max concurrent jobs per tenant for each job type.
// Google Admin SDK has strict rate limits — parallel gws_create_user
// calls trigger 403 "Rate Limit Exceeded" errors and cascade failures.
export const concurrency = {
  gws_create_user: 1,
  gws_suspend_user: 1,
  gws_sync_directory: 1,
  gws_poll_audit: 1,
  gws_add_group_member: 1,
  gws_remove_group_member: 1,
  gws_disconnect: 1,
};
