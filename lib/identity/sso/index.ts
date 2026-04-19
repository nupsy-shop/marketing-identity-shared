/**
 * SSO reconciliation processors.
 *
 * Registered on the SYSTEM queue by the Bull worker alongside
 * `iam_provision_realm`. The web app does not import these — it only
 * enqueues the job via `lib/jobs/enqueue.ts`.
 */

export { default as iamUpsertRealmIdp } from './iam-upsert-realm-idp';
