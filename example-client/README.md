# Example client

Copy one of these TypeScript connectors into an existing PowerSync application. This directory
has no package manifest or runnable UI. It sends local transactions to the write API; the
PowerSync SDK handles the separate sync connection.

## Choose a connector

| Version | Files to copy | Dependencies |
| --- | --- | --- |
| Modular | `src/PowersyncConnector.ts`, `src/library/powersync/`, and `src/generated/api.d.ts` | PowerSync SDK, `openapi-fetch`, `uuid` |
| Single file | `src/PowersyncConnector.singlefile.ts` | PowerSync SDK |

Both versions require `@powersync/web` or `@powersync/react-native` >=1.26.0 for
`getCrudTransactions()`. Change the SDK import for React Native.

Both demos use browser `localStorage` for a demo user ID. Replace that persistence on platforms
without it. The single-file version also needs `crypto.randomUUID()` or a platform UUID generator.
Check that your runtime supplies `fetch` and `AbortSignal.timeout`, or provide equivalents.

`AppSchema.ts` is an illustrative schema, not a required connector import. Keep your application's
existing PowerSync schema or adapt it to match the source database and sync configuration.

## Configure and connect

The modular connector reads these variables through `import.meta.env`. Adapt
`DemoConnectorConfig.ts` if your bundler exposes configuration differently:

| Variable | Meaning |
| --- | --- |
| `VITE_BACKEND_URL` | Write API base URL without a trailing slash, e.g. `http://localhost:6060` |
| `VITE_POWERSYNC_URL` | Actual PowerSync sync endpoint |
| `VITE_POWERSYNC_TOKEN` | Demo token for sync and writes; replace `fetchAuthToken()` in real apps |
| `VITE_BATCH_MAX_TRANSACTIONS` | Transactions per request; use 1–50 (default 1) |
| `VITE_BATCH_MAX_OPERATIONS` | Operation threshold for collecting transactions (default 1000) |
| `VITE_REQUEST_TIMEOUT_MS` | Write request timeout in milliseconds (default 30000) |

See [.env.example](.env.example). Set `VITE_BATCH_MAX_TRANSACTIONS` to a positive integer to
use a custom operation threshold; otherwise the modular connector uses both batch defaults.
The API rejects batches larger than 50 transactions. The operation threshold can be exceeded
by the last transaction collected because the connector does not split transactions.

The single-file connector uses constants at the top instead of environment variables.
Set its URLs, batch thresholds, and timeout there.

After adapting authentication, connect your initialized PowerSync database:

```ts
import { PowersyncConnector } from './PowersyncConnector';

await db.connect(new PowersyncConnector());
```

`db` is your existing PowerSync database instance. For the single-file version, change the
import path. `fetchCredentials()` supplies the sync token; `uploadData()` sends writes.

## Authentication

The backend does not issue tokens. It accepts tokens signed by the provider your PowerSync
instance trusts. The demo `fetchAuthToken()` returns a fixed token (`VITE_POWERSYNC_TOKEN`, or
`AUTH_TOKEN` in the single-file connector), such as a session token copied from your provider.
Both sync and writes reuse it.

For a provider integration, edit the private `fetchAuthToken()` method in your copied connector.
See [Supabase and Clerk](../docs/auth-verifiers.md). If using different tokens for sync and writes,
also adapt `fetchCredentials()`, keeping the same user ID in both tokens.

The modular transport's token callback is `getAuthToken`; its timeout option is `timeoutMs`.
The demo clears its cached token after a 401/403 write response. Provider SDKs should manage
provider sessions without the demo cache.

## Rejected writes

Both connectors expose `onFatalTransaction`, which returns `'retain'` or `'complete'` for
client-directed failures. The default retains the transaction and blocks later uploads.
See [error handling](../docs/error-handling.md) before implementing release or replacement.

## API and connector changes

From the repository root, regenerate types after changing `backend/powersync-reference-write-api.openapi.yaml`:

```bash
pnpm --dir backend generate-types
```

This updates both generated clients. The single-file version has hand-written types; update
those and its behavior using [the maintenance instructions](src/PowersyncConnector.singlefile.prompt.md).
Keep both versions consistent and run `pnpm --dir backend test`.
