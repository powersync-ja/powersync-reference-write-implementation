# Supabase Edge Function

`supabase/functions/powersync-write` serves the same write API as the Express backend from a
Supabase Edge Function. It targets Supabase Postgres and Supabase Auth in the same project.
It reuses the backend's transaction processor, request validator, and Postgres adapter directly
from `backend/src`, so deploying it needs no Node install or build.

Each write runs as the signed-in user. Inside each database transaction the function sets the
verified token claims as `request.jwt.claims` and switches to the `authenticated` role, both
transaction-local. Your existing grants and row-level security policies (`auth.uid()`,
`auth.jwt()`) decide what each user may write. No table allowlist applies.

## Requirements

- A project using asymmetric JWT signing keys, the default for new projects. Older projects
  that still sign with the legacy JWT secret must migrate first; see Supabase's
  [JWT signing keys guide](https://supabase.com/docs/guides/auth/signing-keys). The function
  gets the public keys from the platform; you do not copy keys or the JWT secret.
- Grants to `authenticated` and RLS policies on every table clients write.
- Supabase CLI. Tested with 2.98.2.
- Docker and Deno for local development and tests only. Deploying needs neither.

## Run locally

```bash
supabase start
supabase functions serve
```

`supabase/seed.sql` creates the example client's `lists` and `todos` tables with ownership
policies. Seeds run only locally. `supabase/functions/.env` holds one override that local
development needs: a database host the edge runtime can resolve.
Do not upload that file as hosted secrets.

Use `supabase functions serve` rather than relying on `supabase start` alone. `serve` mounts
the shared `backend/src` files the function imports and reloads on changes.

## Deploy to your project

Deploy from a clone of this repository into your existing Supabase project. Deploying one
function does not change your other functions, schema, or settings.

Run only `supabase functions deploy` and `supabase secrets set` against your project from this
repository. Commands such as `supabase config push` and `supabase db push` would apply this
repository's local development config and schema to your project.

### 1. Link the project

```bash
supabase link --project-ref <project-ref>
```

Alternatively, pass `--project-ref <project-ref>` to each command below.

### 2. Prepare the schema

Create the tables your client writes, with grants to `authenticated` and RLS policies that
use `auth.uid()` or `auth.jwt()`. Table and column names must match the uploaded operations
unless you change `mapper.ts`. Use `supabase/seed.sql` as an example; it is not applied to
hosted projects.

### 3. Set the database connection

Connect through the transaction pooler. Copy its connection string from the dashboard
(**Connect** → **Transaction pooler**), URL-encode any special characters in the password, and
add `sslmode=verify-full`:

```bash
supabase secrets set POWERSYNC_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=verify-full'
```

If this secret is not set, the function connects with the platform-provided `SUPABASE_DB_URL`
instead. The transaction pooler ignores settings sent when a connection opens, so the function
applies the statement timeout from `config.ts` inside each transaction.

### 4. Deploy

```bash
supabase functions deploy powersync-write
```

Without Docker, add `--use-api` to bundle on Supabase's servers. Keep `verify_jwt = true` for
this function in `supabase/config.toml`; the deploy reads it from there.

### 5. Check the deployment

```bash
curl -i -X OPTIONS https://<project-ref>.supabase.co/functions/v1/powersync-write/api/data \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST'
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/powersync-write/api/data
```

The browser preflight returns `204` without a token, and the unauthenticated POST returns `401`. A write with a signed-in
user's access token returns `200` and one result per transaction.

## Connect a client

Set the connector's backend base URL to the function URL. The connector appends `/api/data`:

```text
https://<project-ref>.supabase.co/functions/v1/powersync-write
```

Locally, this is `http://127.0.0.1:54321/functions/v1/powersync-write`. Send the user's
Supabase session access token as the bearer token. API keys, anon tokens, and service-role
tokens are rejected.

The write URL is separate from the PowerSync sync URL, which still points at your PowerSync
instance. That instance must trust the same Supabase Auth tokens; see PowerSync's
[Supabase Auth setup](https://docs.powersync.com/configuration/auth/supabase-auth). See
[example-client](../example-client/README.md) for the connector settings.

## Customize

Edit these files in `supabase/functions/powersync-write/`:

| File | Purpose |
| --- | --- |
| `mapper.ts` | Map client tables and columns; see [schema mapping](../docs/schema-mapping.md) |
| `authorizer.ts` | Extra checks before each transaction; RLS still applies |
| `fatal-error-handler.ts` | Route permanent failures; see [error handling](../docs/error-handling.md). `onDeadLetter` is awaited before the response |
| `config.ts` | Batch policy (`stop`/`skip`), per-worker pool limits, and the statement timeout |

Redeploy after editing.

PATCH and DELETE that match no visible row succeed without changing anything, the same as
the Express backend. A row hidden by RLS counts as no match. A write that violates a policy or
lacks a grant returns a fatal `UNAUTHORIZED` result. Client table and column names must be plain
identifiers, the same as for the Express backend; see
[identifier validation](../docs/schema-mapping.md#identifier-validation).

## Signing keys

The function verifies tokens the standard Supabase way: the platform gateway checks them first
(`verify_jwt`), then the function verifies them with `@supabase/server` against the keys the
platform provides. When rotating signing keys, follow Supabase's
[rotation steps](https://supabase.com/docs/guides/auth/signing-keys), including its notes on
Edge Functions that use Verify JWT.

## Hosted verification

Verified on a hosted project (October 2026, ES256 keys, transaction pooler with
`verify-full`): gateway and credential rejection, RLS isolation, identity on pooled
connections, rollback, batch limits, TLS verification, and the statement timeout. Not yet
verified on hosted: RS256 keys, key rotation, edited hooks, and the `skip` policy.

## Tests

With the local stack and `supabase functions serve` running (`supabase/config.toml` enables the
local transaction pooler, which one test uses):

```bash
cd supabase/functions/powersync-write
deno task test
```

The tests cover writes and RLS isolation across two users, rollback, identity on pooled
connections, the statement timeout through a transaction pooler, request validation, rejected
credentials, RS256 verification, the function's import graph, and the unchanged example
connector.

The function validates requests with `backend/src/generated/transaction-batch-validator.ts`,
which is generated from the OpenAPI spec. After editing the spec, run
`pnpm --dir backend generate-edge-validator`. A backend test fails if the file is stale.
