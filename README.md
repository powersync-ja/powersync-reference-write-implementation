# PowerSync Write API

This backend accepts queued changes from a PowerSync client and writes them to your
source database. PowerSync then syncs that database to clients.

The repository includes an Express API, adapters for Postgres, MongoDB, MySQL, and
SQL Server, and reference TypeScript connectors. You supply the database, PowerSync
instance, client application, and application-specific authorization.

## Setup

Run the commands below from the repository root. Docker Compose runs the backend;
local development and tests use Node.js 24 and pnpm 9. The existing `backend/.nvmrc`
pins an older Node version, so select Node 24 explicitly for local work.

### 1. Configure the database

Edit the root `.env` for Docker Compose:

| Variable | Meaning |
| --- | --- |
| `DATABASE_TYPE` | `postgres` (default), `mongodb`, `mysql`, or `mssql` |
| `DATABASE_URI` | Required connection string for your source database |
| `BATCH_ON_FATAL_ERROR` | `stop` (default) or `skip`; see [error handling](docs/error-handling.md) |

`.env` is committed, so keep it to shared defaults. Put this machine's values and any secret, such
as a `DATABASE_URI` with a password, in a `.env.local` beside it: it is gitignored, optional, and
overrides `.env`. Compose passes both files to the container, so `docker compose up` needs no extra
flags. Setting a variable in your shell no longer overrides them; use `.env.local` instead.

Use the database that your PowerSync instance already replicates. Tables and columns
must match uploaded operations unless you add [schema mapping](docs/schema-mapping.md).
MongoDB transactions require a replica set or sharded cluster; the default MongoDB
mapper also requires collection `$jsonSchema` validators.

In Docker Desktop, use `host.docker.internal` to reach a database on the host.
For a backend running directly on the host, use the database's host-accessible address,
such as `localhost`. Other Docker environments may require a host-gateway configuration.

### 2. Configure authentication

Follow [the auth setup guide](backend/src/auth/SETUP.md). The default backend reads a
PowerSync Cloud export from `backend/powersync-config.json`; generic providers also
require an expected issuer and audience in `backend/src/auth/verifier.ts`.

Compose mounts the export read-only. To use a different file, set `POWERSYNC_CONFIG_PATH`
to its absolute host path in the root `.env`. The file must exist before starting Compose.

For Supabase or Clerk, see [provider integration](docs/auth-verifiers.md). Self-hosted
PowerSync requires adapting the verifier loader as described in the setup guide.
The backend does not issue tokens. It only accepts tokens signed by keys your auth config
trusts, so clients authenticate with the same provider your PowerSync instance uses.

### 3. Start the API

```bash
docker compose up --build
```

The API listens at `http://localhost:6060`. Compose fixes both the container and host
port to 6060; change its `ports` mapping to expose a different host port.

Startup checks the database type, connection string, fatal-error policy, and verifier
configuration. Remote JWKS keys are fetched when needed during token verification.
A successful startup does not prove that every database operation or provider is reachable.

### 4. Connect the client

Copy a connector from [example-client](example-client/README.md) into your app. Configure
its write API URL, PowerSync sync URL, and token retrieval, then pass it to your existing
PowerSync database's `connect()` method. The connector implements:

- `fetchCredentials()`: credentials for the PowerSync sync connection.
- `uploadData()`: sends queued local transactions to `POST /api/data`.

Use a URL reachable from the client device. `localhost` refers to that device, so another
computer or phone needs the backend's network address or a tunnel URL.

## Application behavior

The default authorizer allows all authenticated writes. Add your application's checks in
[`backend/src/auth/authorizer.ts`](backend/src/auth/authorizer.ts); see
[authorization](docs/authorization.md). Configure your PowerSync sync streams or rules
separately to control which rows each user can read.

[Schema mapping](docs/schema-mapping.md) describes field conversion and custom writes.
[Error handling](docs/error-handling.md) explains rejected transactions, queue retention,
and the optional dead-letter callback. By default, fatal failures are logged by the backend
and removed from the client upload queue. The callback does not provide durable storage.

## API

`backend/powersync-reference-write-api.openapi.yaml` defines `POST /api/data`. It accepts 1–50 transactions and processes
them in order, each in its own database transaction. It returns one result per submitted
transaction, including `not_attempted` for transactions after the stopping point.

Processed batches return HTTP 200; inspect the individual result statuses. Request validation
and authentication failures use HTTP errors such as 400 and 401. Transaction outcomes are
`success`, `retryable_error`, `fatal_error`, or `not_attempted`.

`BATCH_ON_FATAL_ERROR=skip` continues after backend-directed fatal failures. Client-directed
fatal failures and retryable failures stop the batch. See [error handling](docs/error-handling.md).

## Development

For Docker with automatic reloads:

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up --build
```

For local execution, stop the Compose backend, create `backend/.env` from
`backend/.env.template`, and configure it for your host's database address and auth setup.
The local process loads `backend/.env`; Compose reads the root `.env`.

```bash
pnpm --dir backend install
pnpm --dir backend dev
```

The local port defaults to 6060 and can be changed with `PORT` in `backend/.env`.
Restart after changing auth configuration. Rebuild the image after code changes when
using Compose without the development overlay.

## Tests and API types

```bash
pnpm --dir backend test
pnpm --dir backend check
pnpm --dir backend generate-types
```

Tests use local fixtures and mocks; they need permission to open local listening ports,
but no Docker, running database, or live identity provider. Type generation updates both
`backend/src/generated/api.ts` and `example-client/src/generated/api.d.ts` from the OpenAPI
spec. Run it after editing the spec.

[The manual checklist](docs/test.txt) provides a separate Postgres test setup.
