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

- A project using asymmetric JWT signing keys (the default for new projects). The function
  discovers the public keys itself; you do not copy keys or the JWT secret.
- Grants to `authenticated` and RLS policies on every table clients write.
- Supabase CLI. Docker and Deno are needed for local development and tests.

## Run locally

```bash
supabase start
supabase functions serve
```

`supabase/seed.sql` creates the example client's `lists` and `todos` tables with ownership
policies. Seeds run only locally. `supabase/functions/.env` holds two overrides that local
development needs: the public token issuer, and a database host the edge runtime can resolve.
Do not upload that file as hosted secrets.

Use `supabase functions serve` rather than relying on `supabase start` alone. `serve` mounts
the shared `backend/src` files the function imports and reloads on changes.

## Connect a client

Set the connector's backend base URL to the function URL. The connector appends `/api/data`:

```text
https://<project-ref>.supabase.co/functions/v1/powersync-write
```

Locally, this is `http://127.0.0.1:54321/functions/v1/powersync-write`. Send the user's
Supabase session access token as the bearer token. API keys, anon tokens, and service-role
tokens are rejected.

## Customize

Edit these files in `supabase/functions/powersync-write/`:

| File | Purpose |
| --- | --- |
| `mapper.ts` | Map client tables and columns; see [schema mapping](schema-mapping.md) |
| `authorizer.ts` | Extra checks before each transaction; RLS still applies |
| `fatal-error-handler.ts` | Route permanent failures; see [error handling](error-handling.md). `onDeadLetter` is awaited before the response |
| `config.ts` | Batch policy (`stop`/`skip`) and per-worker pool limits |

PATCH and DELETE that match no visible row succeed without changing anything, the same as
the Express backend. A row hidden by RLS counts as no match. A write that violates a policy or
lacks a grant returns a fatal `UNAUTHORIZED` result.

## Deploy

```bash
supabase functions deploy powersync-write
```

Keep `verify_jwt = true` (set in `supabase/config.toml`). Connect through the transaction
pooler by setting its connection string as a secret:

```bash
supabase secrets set POWERSYNC_DATABASE_URL='postgresql://...pooler.supabase.com:6543/postgres?sslmode=verify-full'
```

The transaction pooler ignores settings sent when a connection opens, so the persister applies
the configured `statement_timeout` inside each transaction instead.

Without it, the function uses the injected `SUPABASE_DB_URL`. The issuer is derived from
`SUPABASE_URL`; set `POWERSYNC_JWT_ISSUER` only if your tokens use a different issuer.

A first hosted run (2026-10-13, ES256, eu-west-2, transaction pooler with `verify-full`) passed
the gateway, credential, RLS, pooled-identity, batch, TLS and timeout checks. Still unverified on
hosted: RS256, key rotation, controlled-claims tokens, the editable hooks, the skip policy and
JWKS outages. See [the hosted test specification](../.planning/supabase-edge/hosted-test-spec.md).

## Tests

With the local stack and `supabase functions serve` running (`supabase/config.toml` enables the
local transaction pooler, which one test uses):

```bash
cd supabase/functions/powersync-write
deno task test
```

The tests cover writes and RLS isolation across two users, rollback, identity on pooled
connections, request validation, rejected credentials, RS256 verification, the function's
import graph, and the unchanged example connector.

The function validates requests with `backend/src/generated/transaction-batch-validator.ts`,
which is generated from the OpenAPI spec. After editing the spec, run
`pnpm --dir backend generate-edge-validator`. A backend test fails if the file is stale.
