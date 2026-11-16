# Example client

Copy one of these TypeScript client connectors into your PowerSync app. This directory has no
runnable UI; its `package.json` only type-checks the connectors (`pnpm check`). Each client
connector sends local transactions to the write API; the PowerSync SDK handles the separate sync
connection.

The connectors need `@powersync/web` 2.6.0 or `@powersync/react-native` 2.4.0 or later.

## Choose a client connector

| Version | Files to copy | Dependencies |
| --- | --- | --- |
| Modular | `src/PowersyncConnector.ts`, `src/library/powersync/`, and `src/generated/api.d.ts` | PowerSync SDK, `openapi-fetch`, `uuid` |
| Single file | `src/PowersyncConnector.singlefile.ts` | PowerSync SDK |

For React Native, change the SDK import from `@powersync/web` to `@powersync/react-native`.

Both demos use browser `localStorage` for a demo user ID. Replace that persistence on platforms
without it. The single-file version also needs `crypto.randomUUID()` or a platform UUID generator.
Check that your runtime supplies `fetch` and `AbortSignal.timeout`, or provide equivalents.

`AppSchema.ts` is an illustrative schema, not a required connector import. Keep your application's
existing PowerSync schema or adapt it to match the source database and sync configuration.

## Configure and connect

The modular client connector reads these variables through `import.meta.env`. Adapt
`DemoConnectorConfig.ts` if your bundler exposes configuration differently:

| Variable | Meaning |
| --- | --- |
| `VITE_BACKEND_URL` | Write API base URL without a trailing slash, e.g. `http://localhost:6060` |
| `VITE_POWERSYNC_URL` | Your PowerSync instance URL, passed to `connect()` |
| `VITE_POWERSYNC_TOKEN` | Demo token for sync and writes; replace `fetchAuthToken()` in real apps |
| `VITE_BATCH_MAX_TRANSACTIONS` | Transactions per request; use 1–50 (default 1) |
| `VITE_BATCH_MAX_OPERATIONS` | Operation threshold for collecting transactions (default 1000) |
| `VITE_REQUEST_TIMEOUT_MS` | Write request timeout in milliseconds (default 30000) |

See [.env.example](.env.example). Batching is enabled only when `VITE_BATCH_MAX_TRANSACTIONS`
is a positive integer; `VITE_BATCH_MAX_OPERATIONS` is then optional. Otherwise the connector
uploads one transaction per request. The write API rejects batches larger than 50 transactions. The operation threshold can be exceeded
by the last transaction collected because the connector does not split transactions.

The single-file client connector uses constants at the top instead of environment variables.
Set its write API URL, batch thresholds, and timeout there.

Connect your initialized PowerSync database with an `Authenticator` and the connector's `upload`
callback. This demo authenticator returns the fixed `VITE_POWERSYNC_TOKEN`:

```ts
import type { Authenticator } from '@powersync/web';
import { PowersyncConnector } from './PowersyncConnector';
import { readDemoConfig } from './library/powersync/DemoConnectorConfig';

const config = readDemoConfig();

// Replace with your auth provider's token retrieval.
async function fetchAuthToken(): Promise<string> {
  if (!config.authToken) {
    throw new Error('No auth token. Set VITE_POWERSYNC_TOKEN or replace fetchAuthToken().');
  }
  return config.authToken;
}

let cachedToken: string | null = null;

const authenticator: Authenticator = {
  async resolveCredentials() {
    cachedToken ??= await fetchAuthToken();
    return cachedToken;
  },
  // Called after PowerSync or the write API rejects the token, and before it expires.
  invalidateCredentials() {
    cachedToken = null;
  }
};

const connector = new PowersyncConnector({ authenticator });
await db.connect({ powerSyncEndpoint: config.powersyncUrl, authenticator, upload: connector.upload });
```

`db` is your existing PowerSync database instance. The authenticator supplies the token for sync,
and the connector uses it for writes. For the single-file version, change the import path and
pass your PowerSync instance URL as `powerSyncEndpoint`.

## Migrating from a Backend Connector

If your app connects with a `PowerSyncBackendConnector`, move its `fetchCredentials()` into an
`Authenticator` and replace its `uploadData()` with the connector's `upload` callback. An app
can't pass both a backend connector and an `upload` callback to `connect()`.

Before:

```ts
class MyConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    return { endpoint: POWERSYNC_URL, token: await fetchAuthToken() };
  }

  async uploadData(database: CommonPowerSyncDatabase) {
    // ...
  }
}

await db.connect(new MyConnector());
```

After:

```ts
const authenticator: Authenticator = {
  async resolveCredentials() {
    return fetchAuthToken();
  }
};

const connector = new PowersyncConnector({ authenticator });
await db.connect({ powerSyncEndpoint: POWERSYNC_URL, authenticator, upload: connector.upload });
```

PowerSync caches the token from a backend connector but not from an `Authenticator`. If
`fetchAuthToken()` makes a network request, cache its result and clear the cache in
`invalidateCredentials()`, as in the demo above. `resolveCredentials()` returns only the token,
so drop any `expiresAt`.

## Authentication

Neither backend issues tokens. Configure the Express backend to trust your token provider,
or use Supabase Auth with the Supabase Edge Function. Your PowerSync instance must trust
the tokens used for sync. The demo authenticator returns a fixed token, such as a session token
copied from your provider. Both sync and writes use it.

The connector takes write tokens from the authenticator you pass it. Each write request calls
`resolveCredentials()`. After a 401 or 403 write response, the connector calls
`invalidateCredentials()` and the upload is retried. For a provider integration, replace the demo
authenticator; see [Supabase and Clerk](../docs/auth/providers.md). If writes need a different
token from sync, pass the connector a second authenticator, keeping the same user ID in both tokens.

If your provider SDK refreshes sessions itself, return its current token from
`resolveCredentials()` without a cache. For Supabase, see
[Using Supabase Auth in the connector](../backend/supabase/README.md#using-supabase-auth-in-the-connector).

The modular transport's token callback is `getAuthToken`; its timeout option is `timeoutMs`.

## Rejected writes

Both client connectors expose `onFatalTransaction`, which returns `'retain'` or `'complete'` for
client-directed failures. The default retains the transaction and blocks later uploads.
See [error handling](../docs/error-handling.md) before implementing release or replacement.

## API and connector changes

From the repository root, regenerate types after changing `backend/shared/powersync-reference-write-api.openapi.yaml`:

```bash
pnpm --dir backend generate-types
```

This updates both generated clients. The single-file version has hand-written types; update
those and its behavior using [the maintenance instructions](../docs/single-file-connector-maintenance.md).
Keep both versions consistent and run `pnpm --dir backend test`.
