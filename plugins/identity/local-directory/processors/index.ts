export default {
  iam_provision_identity: () => import('./iam-provision-identity.js'),
  iam_teardown_identity: () => import('./iam-teardown-identity.js'),
  iam_update_identity: () => import('./iam-update-identity.js'),
  iam_provision_app_user: () => import('./iam-provision-app-user.js'),
  iam_disable_app_user: () => import('./iam-disable-app-user.js'),
  iam_enable_app_user: () => import('./iam-enable-app-user.js'),
  iam_deprovision_app_user: () => import('./iam-deprovision-app-user.js'),
  local_group_writeback_dispatch: () => import('./local-group-writeback-dispatch.js'),
};

export const concurrency = {
  iam_provision_app_user: 2,
  iam_disable_app_user: 2,
  iam_enable_app_user: 2,
  iam_deprovision_app_user: 2,
  local_group_writeback_dispatch: 2,
};
