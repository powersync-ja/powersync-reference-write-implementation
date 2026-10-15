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

Connection string notes: percent-encode special characters in passwords. Postgres accepts `?sslmode=require` (or `verify-full`) for managed databases. MSSQL verifies the server certificate by default; add `?trustServerCertificate=true` only for self-signed development servers. Missing ports default to 5432 (Postgres) and 1433 (MSSQL). Pools are capped at 10 connections with connect and statement timeouts.
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

The backend accepts tokens signed by keys it trusts, normally the same provider your PowerSync instance trusts,
so clients authenticate with the same provider for read and write.
The default `backend/src/auth/verifier.ts` reads a PowerSync Cloud JSON export, resolves its authentication settings, and builds a verifier.
It may need additional trusted settings, such as the expected issuer or audience.

Choose an integration:

- **PowerSync Cloud or self-hosted PowerSync:** save your config as
  `backend/config/powersync-config.json` (the default) and set any `AUTH_*` supplements; see
  [auth setup](docs/auth/setup.md#config-file-default).
- **Any other provider (Clerk, Auth0, Supabase):** set `AUTH_MODE=env` with your issuer,
  audience and JWKS URL, no file needed. See [auth setup](docs/auth/setup.md#environment-variables-only)
  and the [Supabase and Clerk guide](docs/auth/providers.md).

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

- `fetchCredentials()`: credentials for the PowerSync sync connection. If your application is already reading data from PowerSync then you will have already implemented this function, we recommend that you keep your existing implementation and configure the API to trust the same issuers - see [auth setup](docs/auth/setup.md).
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

[Conflict resolution](docs/conflict-resolution.md) documents the approach taken in this reference implementation, as well as alternative
conflict resolution approaches that can be implemented.

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
