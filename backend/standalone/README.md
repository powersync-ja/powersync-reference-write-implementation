# Standalone Express backend

The standalone Express backend receives queued writes from your PowerSync app and applies them to
your source database. Use it with Postgres, MongoDB, MySQL, or SQL Server when you want to run
your own write backend and customize authentication, authorization, and write processing.

It uses the transaction processor and database adapters in the [shared core](../shared).
For Supabase apps, the [Supabase Edge Function](../supabase/README.md) provides an alternative
deployment that enforces your existing RLS policies.

## Setup

Run commands from the repository root. Docker Compose runs the Express backend; local development and
tests use Node.js 24 and pnpm 9.

1. Set `DATABASE_TYPE` (`postgres`, `mongodb`, `mysql`, or `mssql`) and `DATABASE_URI` in the
   root `.env.local`. Connect to the source database that your PowerSync instance replicates
   from. See [database setup](../../README.md#1-configure-the-database) for schema requirements
   and connection details.
2. Configure token verification using a PowerSync config file at
   `backend/standalone/config/powersync-config.json`, or set `AUTH_MODE=env` and your provider's
   issuer, audience, and JWKS URL. See [authentication setup](../../docs/auth/setup.md) for
   required settings and [development tokens](../../docs/auth/development-tokens.md) for
   trying the write API without an auth provider.
3. Add your application's write permissions in [authorizer.ts](src/auth/authorizer.ts).
   **The default authorizer allows all authenticated writes.** See
   [authorization](../../docs/auth/authorization.md) for implementing checks.
4. Start the Express backend:

   ```bash
   docker compose up --build
   ```

The Express backend listens at `http://localhost:6060`. Copy a client connector from
[example-client](../../example-client/README.md) into your app and configure its write API
base URL, PowerSync instance URL, and token retrieval. Use an Express backend address reachable from
the client device.

## Write processing and customization

The client connector sends queued transactions to `POST /api/data`. The Express backend validates the request,
verifies the bearer token, and processes transactions in order, each in its own database
transaction. See the [API contract](../shared/powersync-reference-write-api.openapi.yaml)
for request and response formats.

Customize [schema mapping](../../docs/schema-mapping.md) to transform uploaded table names,
fields, or values. See [error handling](../../docs/error-handling.md) for transaction outcomes,
retry behavior, and the fatal-error hook, and [conflict resolution](../../docs/conflict-resolution.md)
for how concurrent writes are handled. PowerSync Sync Streams separately control which rows
your app can read.

## Code navigation

| File | Purpose |
| --- | --- |
| [index.ts](index.ts) | Initializes dependencies, checks database connectivity, and starts the server |
| [app.ts](app.ts) | Express middleware, request validation, and routes |
| [src/api/data.ts](src/api/data.ts) | Upload request handler |
| [src/auth/verifier.ts](src/auth/verifier.ts) | Token verification configuration |
| [src/auth/authorizer.ts](src/auth/authorizer.ts) | Application write permissions |
| [src/persistence/persister-factories.ts](src/persistence/persister-factories.ts) | Database adapters and custom mapper installation |
| [src/fatal-error-handler.ts](src/fatal-error-handler.ts) | Hook for rejected transactions |
| [Shared transaction processor](../shared/src/write/processor.ts) | Transaction processing used by both backends |
