# PowerSync Reference Write Implementation

When your PowerSync-enabled front-end app writes data using SQL INSERT, UPDATE, or DELETE statements,
PowerSync automatically queues these mutations for processing using the `uploadData` function.

While there are no restrictions on the implementation of `uploadData` and the related backend API,
this repository provides a reference implementation for both the client-side implementation and the backend
API which will support most simple use-cases.  It provides extension points that will allow you to customize
the behavior to your own requirements, or you can modify it to suit your specific case.

- [backend/powersync-reference-write-api.openapi.yaml](backend/powersync-reference-write-api.openapi.yaml) provides a simple but flexible API definition that serves as a contract between frontend and backend.
- A [reference implementation](example-client/src/PowersyncConnector.ts) of `uploadData` handles most common workflows. It will marshal queued changes to the format specified by the API definition. A [single-file version](example-client/src/PowersyncConnector.singlefile.ts) is provided for ease of copy-paste.
- A [reference backend](backend) accepts API requests from the front-end and writes them to your source database. This includes an Express API, adapters for Postgres, MongoDB, MySQL, and SQL Server.

You supply the database, PowerSync instance, client application, and application-specific authorization, and you must copy the example `uploadData` implementation to your front-end code.

## Setup

Run the commands below from the repository root. `docker compose` runs the backend;
local development and tests use Node.js 24 and pnpm 9.

### 1. Configure the database

Set these in `.env.local` (or the root `.env` for shared defaults) for Docker Compose:

| Variable | Meaning |
| --- | --- |
| `DATABASE_TYPE` | `postgres` (default), `mongodb`, `mysql`, or `mssql` |
| `DATABASE_URI` | Required connection string for your source database |
| `BATCH_ON_FATAL_ERROR` | `stop` (default) or `skip`; see [error handling](docs/error-handling.md) |

`.env` is committed, so keep it to shared defaults. Put this machine's values and any secret, such
as a `DATABASE_URI` with a password, in `.env.local`. This is gitignored, optional, and
overrides `.env`. Compose passes both files to the container, so `docker compose up` needs no extra
flags.

Use the database that your PowerSync instance already replicates. Tables and columns
must match uploaded operations unless you add custom [schema mapping](docs/schema-mapping.md).
The default MongoDB mapper also requires collection `$jsonSchema` validators.

In Docker Desktop, use `host.docker.internal` to reach a database on the host.
For a backend running directly on the host, use the database's host-accessible address,
such as `localhost`. Other Docker environments may require a host-gateway configuration.

### 2. Configure authentication

The backend does not issue tokens. It accepts only tokens signed by keys this configuration
trusts, normally the same provider your PowerSync instance trusts, so clients authenticate
with the same provider. The default `backend/src/auth/verifier.ts` reads a PowerSync Cloud
JSON export, resolves its authentication settings, and builds a verifier. It may need
additional trusted settings, such as the expected issuer or audience.

Choose an integration:

- **PowerSync Cloud:** export your config to `backend/powersync-config.json` and set any
  `AUTH_*` supplements; see [auth setup](docs/auth/setup.md). Supabase with asymmetric
  signing keys is supported by this path.
- **Self-hosted PowerSync:** adapt the loader to use `resolveSelfHostedAuth`, as described in
  [auth setup](docs/auth/setup.md#self-hosted-powersync). The default loader does not read
  YAML or detect self-hosted configuration automatically.
- **Custom provider:** preserve the startup and request exports when replacing the verifier.
  See [Supabase and Clerk integration](docs/auth/verifiers.md).

The export commands require the [PowerSync CLI](https://docs.powersync.com/tools/cli).
Compose mounts the export read-only. To use a different file, set `POWERSYNC_CONFIG_PATH`
to its absolute host path in the root `.env`. The file must exist before starting Compose.

### 3. Start the API

```bash
docker compose up --build
```

The API listens at `http://localhost:6060`. Compose fixes both the container and host
port to 6060; change its `ports` mapping to expose a different host port.

Startup checks the database type, connection string, fatal-error policy, and verifier configuration.

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
[authorization](docs/auth/authorization.md). Configure your PowerSync sync streams or rules
separately to control which rows each user can read.

[Schema mapping](docs/schema-mapping.md) describes field conversion and custom writes.
[Error handling](docs/error-handling.md) explains rejected transactions, queue retention,
and the optional dead-letter callback. By default, fatal failures other than `UNAUTHORIZED` are logged by the backend
and removed from the client upload queue; authorization rejections stay queued. The callback does not provide durable storage.

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
Rebuild the image after code changes when using Compose without the development overlay.

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

[The manual checklist](docs/manual-test-plan.md) provides a separate Postgres test setup.
