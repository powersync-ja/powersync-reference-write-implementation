# Supabase Edge Function

`backend/supabase/functions/powersync-write` serves the same write API as the Express backend from a
Supabase Edge Function. It targets Supabase Postgres and Supabase Auth in the same project.
It reuses the backend's transaction processor, request validator, and Postgres adapter directly
from `backend/shared` (mapped as `@powersync/write-core/` in the function's `deno.json`), so
deploying it needs no Node install or build.

Each write runs as the signed-in user. Inside each database transaction the function sets the
verified token claims as `request.jwt.claims` and switches to the `authenticated` role, both
transaction-local. Your existing grants and row-level security policies (`auth.uid()`,
`auth.jwt()`) decide what each user may write. No table allowlist applies.

## Requirements

- A project using asymmetric JWT signing keys, the default for new projects. Older projects
  that still sign with the legacy JWT secret must migrate first; see Supabase's
  [JWT signing keys guide](https://supabase.com/docs/guides/auth/signing-keys). The function
  gets the public keys from the platform; you do not copy keys or the JWT secret.
- Grants to `authenticated` and RLS policies on every table clients write. Table and column
  names must match the uploaded operations unless you change `mapper.ts`.
- Supabase CLI. Tested with 2.98.2.

## Deploy to your project

Deploy from a clone of this repository into your existing Supabase project. Deploying one
function does not change your other functions, schema, or settings. Run the commands below from
`backend/`, where the Supabase CLI finds this `supabase/` directory.

> [!WARNING]
> Against your project, run only `supabase functions deploy powersync-write` and
> `supabase secrets set` from this repository. Other commands, such as `supabase config push`,
> can apply this repository's local development config to your project.

### 1. Link the project

```bash
supabase link --project-ref <project-ref>
```

Alternatively, pass `--project-ref <project-ref>` to each command below.

### 2. Deploy

```bash
supabase functions deploy powersync-write
```

Without Docker, add `--use-api` to bundle on Supabase's servers. Keep `verify_jwt = true` for
this function in `backend/supabase/config.toml`; the deploy reads it from there.

### 3. Check the deployment

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

Send the user's
Supabase session access token as the bearer token. API keys, anon tokens, and service-role
tokens are rejected.

Your PowerSync sync URL does not change. See [example-client](../../example-client/README.md)
for the connector settings.

## Customize

Edit these files in `backend/supabase/functions/powersync-write/`:

| File | Purpose |
| --- | --- |
| `mapper.ts` | Map client tables and columns; see [schema mapping](../../docs/schema-mapping.md) |
| `authorizer.ts` | Extra checks before each transaction; RLS still applies |
| `fatal-error-handler.ts` | Route permanent failures; see [error handling](../../docs/error-handling.md). `onDeadLetter` is awaited before the response |
| `config.ts` | Batch policy (`stop`/`skip`), per-worker pool limits, and the statement timeout |

Redeploy after editing.

### Database connection

The function connects with the platform-provided `SUPABASE_DB_URL`; no setup is needed. To use
a different connection, for example the transaction pooler with TLS verification, set
`POWERSYNC_DATABASE_URL`. Copy the pooler string from the dashboard (**Connect** →
**Transaction pooler**), URL-encode any special characters in the password, and add
`sslmode=verify-full`:

```bash
supabase secrets set POWERSYNC_DATABASE_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=verify-full'
```

`SUPABASE_DB_URL` is the project's direct connection. Each function worker keeps its own pool
of up to three connections, and every one counts against the database's `max_connections`, so
switch to the transaction pooler if many workers run at once. Names starting with `SUPABASE_`
are reserved for secrets, which is why the override has its own name.

The transaction pooler ignores settings sent when a connection opens, so the function applies
the statement timeout from `config.ts` inside each transaction.

PATCH and DELETE that match no visible row succeed without changing anything, the same as
the Express backend. A row hidden by RLS counts as no match. A write that violates a policy or
lacks a grant returns a fatal `UNAUTHORIZED` result. Client table and column names must be plain
identifiers, the same as for the Express backend; see
[identifier validation](../../docs/schema-mapping.md#identifier-validation).

## Signing keys

The function verifies tokens the standard Supabase way: the platform gateway checks them first
(`verify_jwt`), then the function verifies them with `@supabase/server` against the keys the
platform provides. When rotating signing keys, follow Supabase's
[rotation steps](https://supabase.com/docs/guides/auth/signing-keys), including its notes on
Edge Functions that use Verify JWT.
