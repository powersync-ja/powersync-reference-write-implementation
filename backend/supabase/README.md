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
  names must match the uploaded operations unless you change `mapper.ts`; see
  [schema mapping](../../docs/schema-mapping.md#supabase-edge-function).
- An `id` primary key or unique column on each of those tables, holding the client's row ID; see
  [row ID](../../docs/schema-mapping.md#row-id).
- Supabase CLI. Tested with 2.98.2.

## Authorization

Row-level security and grants are the authorization for this function. Deployed without code
changes, it checks every write against your RLS policies as the signed-in user. You do not need
to edit `authorizer.ts`.

Before deploying, enable RLS on every table clients can write and add policies for each operation
they upload. PUT is an upsert, so it needs `INSERT` and `UPDATE` policies, and the existing row
must be visible to the user. PATCH needs `UPDATE` and DELETE needs `DELETE`. Use `WITH CHECK` so
users cannot assign rows to someone else.

> [!WARNING]
> A table without RLS is writable by any signed-in user, for any row, if `authenticated` has
> grants on it. Check every table in the schemas clients write to, not only the ones you sync.

For example, letting users manage only their own lists:

```sql
grant select, insert, update, delete on public.lists to authenticated;
alter table public.lists enable row level security;

create policy "Owners manage their lists" on public.lists
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
```

> [!WARNING]
> A write that a policy or missing grant denies returns a fatal `UNAUTHORIZED` result for the
> whole transaction, and by default the write is discarded. The client drops it from its upload
> queue, the next sync replaces the user's local change with the server's data, and only
> `onDeadLetter` in `fatal-error-handler.ts` records it. A mistake in a policy or grant therefore
> loses user writes without an error the user sees. Test your policies before deploying, and send
> `onDeadLetter` somewhere you monitor.
>
> The Express backend instead keeps `UNAUTHORIZED` queued by default. Keeping it
> queued preserves the change but blocks that user's later uploads until it is handled. To
> choose that, change `requiresClientHandling` in `fatal-error-handler.ts`; see
> [error handling](../../docs/error-handling.md).
>
> PATCH and DELETE of a row that RLS hides from the user succeed without changing anything; see
> [Database connection](#database-connection).

Use `authorizer.ts` only for checks RLS cannot express, such as rejecting a transaction based on
which tables it touches before any write runs. RLS still applies to every write it allows.

## Deploy to your project

Deploy from a clone of this repository into your existing Supabase project. Deploying one
function does not change your other functions, schema, or settings. Run the commands below from
`backend/`, where the Supabase CLI finds this `supabase/` directory.

> [!WARNING]
> Against your project, run only `supabase functions deploy powersync-write` and
> `supabase secrets set` from this repository. Other commands, such as `supabase config push`,
> can apply this repository's local development config to your project.

To deploy from your own repository instead, copy all of `backend/` and run the same commands
from there. To keep the function inside your own `supabase/` directory, copy
`functions/powersync-write` into it and copy `backend/shared` next to that `supabase/` directory,
because the function's `deno.json` maps `@powersync/write-core/` to `../../../shared/src/`. If you
place `shared` elsewhere, update that path. Copy only the `[functions.powersync-write]` section
(`verify_jwt = true`) into your `config.toml`, not this repository's whole config.

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

The browser preflight returns `204` without a token, and the unauthenticated POST returns `401`.
A write with a signed-in user's access token returns `200` and one result per transaction.

## Connect a client

Set the connector's backend base URL (`VITE_BACKEND_URL`, or `BACKEND_URL` in the single-file
connector) to the function URL. The connector appends `/api/data`:

```text
https://<project-ref>.supabase.co/functions/v1/powersync-write
```

Send the user's Supabase session access token as the bearer token. API keys, anon tokens, and
service-role tokens are rejected.

Your PowerSync sync URL does not change, and your PowerSync instance must trust the same
Supabase Auth tokens; see PowerSync's
[Supabase Auth setup](https://docs.powersync.com/configuration/auth/supabase-auth). See
[example-client](../../example-client/README.md) for the connector settings.

### Using Supabase Auth in the connector

Pass your app's supabase-js client to the copied connector and read the session on every call.
Do not keep the connector's token cache: supabase-js refreshes the session itself, and the cache
is cleared only after a rejected write, so sync would keep receiving an expired token. In
`PowersyncConnector.ts`, replace `fetchCredentials()`, `fetchAuthToken()`, and `getAuthToken()`:

```ts
constructor(private readonly supabase: SupabaseClient) {
  // existing setup
}

async fetchCredentials() {
  const session = await this.getSession();
  return {
    endpoint: this.config.powersyncUrl,
    token: session.access_token,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : undefined
  };
}

private async getSession() {
  const { data: { session }, error } = await this.supabase.auth.getSession();
  if (!session || error) throw new Error('Not signed in to Supabase');
  return session;
}

// Write requests call this through the transport.
private async getAuthToken(): Promise<string> {
  return (await this.getSession()).access_token;
}
```

The single-file connector has the same methods; use `POWERSYNC_URL` instead of
`this.config.powersyncUrl`. Remove the now-unused `_authToken` field, including its reset in
`onTransportError()`. Uploads, batching, and error handling are unchanged.

## Customize

Edit these files in `backend/supabase/functions/powersync-write/`:

| File | Purpose |
| --- | --- |
| `mapper.ts` | Map client tables and columns; see [schema mapping](../../docs/schema-mapping.md) |
| `authorizer.ts` | Optional checks before each transaction; RLS is the primary authorization (see [Authorization](#authorization)) |
| `fatal-error-handler.ts` | Route permanent failures; see [error handling](../../docs/error-handling.md). By default every fatal error, including `UNAUTHORIZED`, leaves the client queue. `onDeadLetter` is awaited before the response |
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
