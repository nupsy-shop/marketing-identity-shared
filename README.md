# marketing-identity-shared

Shared libraries for the AccessHive platform — used by both the web app (`marketing-identity`) and the Bull worker (`marketing-identity-bull`).

## Files

| File | Purpose |
|------|---------|
| `lib/audit/client.js` | Elasticsearch client (native fetch) |
| `lib/audit/publisher.js` | Audit event publishing (ES-only, pluggable notification hook) |
| `lib/audit/query.js` | Audit event querying |
| `lib/keycloakAdmin.js` | Keycloak admin API (token caching, user CRUD, SAML) |
| `lib/logger.js` | Structured JSON logging |

## Usage

Added as a git submodule in both repos:

```bash
git submodule add https://github.com/nupsy-shop/marketing-identity-shared.git shared
```

Web app imports: `@/shared/lib/...`
Worker imports: `../../shared/lib/...`

No npm dependencies — all files use only Node.js built-ins.
