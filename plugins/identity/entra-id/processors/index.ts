export default {
  entra_suspend_user: () => import('./entra-suspend-user.js'),
  entra_unsuspend_user: () => import('./entra-unsuspend-user.js'),
  entra_add_group_member: () => import('./entra-add-group-member.js'),
  entra_remove_group_member: () => import('./entra-remove-group-member.js'),
};

export const concurrency = {
  entra_suspend_user: 2,
  entra_unsuspend_user: 2,
  entra_add_group_member: 2,
  entra_remove_group_member: 2,
};
