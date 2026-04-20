# Identity Plugins — folder conventions

Each identity plugin owns provider-specific behavior (drift adapters,
processors, remediations). The central workflow engine and Bull worker
resolve plugin code via explicit registries in this directory — no
filesystem discovery.

## Folder layout

```
shared/plugins/identity/
  common/                          ← shared contracts & interfaces
    drift-adapter.interface.ts
    remediation-contract.ts        ← PluginRemediationModule (issue #92)
  drift-adapter-registry.ts        ← explicit Map<pluginKey, DriftAdapter>
  remediations-registry.ts         ← explicit list<PluginRemediationModule>
  <plugin-key>/
    drift-adapter.ts               ← optional; registered in drift-adapter-registry
    processors/
      index.ts                     ← Bull job type → processor map
      <job-type>.ts
    remediations/
      index.ts                     ← exports PluginRemediationModule
      handlers/
        <action>.ts                ← one file per action handler
```

## Remediation actions — namespacing

Action types contributed by a plugin **must** be namespaced as
`${pluginKey}:${actionName}` — for example
`local-directory:link_keycloak_identity`. The registry enforces this at
boot and refuses to start if:

- A handler key is not namespaced.
- The namespace does not match the plugin's `pluginKey`.
- Two plugins register the same action type.
- A template step references a namespaced action type that is not
  registered by the same plugin.

## Central vs. plugin-owned handlers

Access-request / workflow-engine primitives stay in
`lib/workflows/steps/action.ts`:

- `grant_access`
- `revoke_access`
- `create_task`
- `update_status`
- `capture_before_state`
- `restore_before_state`

Any plugin-specific remediation (e.g. linking a Keycloak identity,
reconciling a GWS alias) lives in `remediations/handlers/` and is
surfaced through the plugin's `PluginRemediationModule`.

## Adding a plugin's remediation module

1. Create `<plugin-key>/remediations/index.ts` that default-exports a
   `PluginRemediationModule` — see
   `local-directory/remediations/index.ts` for the reference.
2. Add its import + entry to `REGISTERED_PLUGINS` in
   `shared/plugins/identity/remediations-registry.ts`.
3. Boot the app. If any validation fails, startup throws a
   `PluginRemediationRegistrationError`.

## Runtime

Plugin remediation handlers use `getRuntime().prisma` / `logger` (set by
the host at startup — `lib/shared-runtime-init.ts` on the web side, Bull
worker entrypoint on the worker side). They run under
`withTenantContext(agency_id, …)` just like every other plugin code path.
