# Authorization

> [!NOTE]
> Using the [Supabase Edge Function](../../backend/supabase/README.md)? Authorize writes with
> row-level security; the authorization hook below is optional. See
> [Supabase authorization](../../backend/supabase/README.md#authorization).

Authentication identifies the caller. Authorization determines which writes the
caller may make. The Express backend's default authorizer allows all authenticated writes.

## Authorization hook

`backend/standalone/src/auth/authorizer.ts` exports an `Authorizer` (the interface is defined in
`backend/shared/src/types.ts`), called once per transaction by the shared core's transaction processor
(`backend/shared/src/write/processor.ts`) before persistence:

```ts
export interface Authorizer {
  authorize(crud: CrudEntry[], auth: AuthContext): boolean | Promise<boolean>;
}
```

`crud` contains the operations sent by the client connector. Its table names and `op_data` keys have
already passed [identifier validation](../schema-mapping.md#identifier-validation); values have
not, so pass them as query parameters, never interpolated into SQL. `auth` contains the verified
token subject and claims: `{ sub, claims }`.

Returning `false` rejects the whole transaction with `UNAUTHORIZED`. The default
[fatal-error handler](../error-handling.md) treats this as client-directed: the transaction stays
queued on the client and is retried, so a denied write is not lost. It blocks later uploads
until the permission is granted or the app's `onFatalTransaction` hook releases it. To drop
denied writes instead, change `requiresClientHandling` in `backend/standalone/src/fatal-error-handler.ts`.

Replace `authorizer` with your application's checks, such as table permissions or
required roles. The default implementation logs this message on every call:

```
Authorization is not configured. All authenticated writes are allowed. Configure backend/standalone/src/auth/authorizer.ts; see docs/auth/authorization.md.
```

## Checking existing rows

The hook receives the uploaded operations and verified identity. The `Persister`
interface provides no method for reading existing rows. Checks that depend on a row's
current owner should run inside the persister's database transaction.

Use `authorize()` for checks that need no database lookup. For example, an application
that accepts writes only to `lists` and `todos` could use:

```ts
// Replace the existing export in backend/standalone/src/auth/authorizer.ts.
export const authorizer: Authorizer = {
  authorize(crud) {
    return crud.every((entry) => ['lists', 'todos'].includes(entry.table));
  }
};
```

This checks the uploaded table names. It does not establish row ownership.
Likewise, comparing a client-supplied `op_data.owner_id` to `auth.sub` only checks the
submitted value. To verify ownership, check the existing row using the verified subject.

For updates and deletes, you can include the ownership condition in the database write,
for example `UPDATE ... WHERE id = $1 AND owner_id = $2`, with `auth.sub` as the owner.
Handle the case where no row matches according to your application's error policy.

## MongoDB, MySQL, and SQL Server adapters

These adapters receive `auth` in `updateBatch` but do not use it. Add permission checks
in `authorize()`, or check existing rows within the adapter's database transaction.

## Postgres row-level security

**This is Postgres only. The MongoDB, MySQL, and SQL Server adapters do not set an
identity value.**

`createPostgresPersister` sets `request.jwt.claims` to the verified token claims, as JSON, at
the start of each transaction:

```ts
await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(auth.claims)]);
```

The `true` argument scopes the setting to that transaction. This is the convention PostgREST
(v10 and later) and Supabase use, so compatible policies can read the same claims. The connection role must also be subject
to RLS and covered by those policies. Your row-level
security policies can read the subject with
`current_setting('request.jwt.claims', true)::json->>'sub'`, or any other claim the same way.

**N.B. The Express backend sets the
identity value but does not create policies.** You must define and enable policies for your schema and database role.

Plain Postgres has no `auth.uid()` function; that is a Supabase helper. You can define your own
in a schema of your choice. Do not use `auth` if you might run on Supabase, which owns that schema.

```sql
CREATE SCHEMA app_auth;
CREATE FUNCTION app_auth.uid() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.claims', true)::json->>'sub'
$$;
```

The Supabase Edge Function sets the same claims and also switches to the `authenticated` role,
so standard Supabase policies using `auth.uid()` apply. See
[Supabase authorization](../../backend/supabase/README.md#authorization).

### Requirements for policies to take effect

- **Connect as a non-owner role.** Table owners, superusers, and roles with `BYPASSRLS`
  skip row-level security. If `DATABASE_URI` connects as one of these, policies are
  silently ignored and `request.jwt.claims` has no effect. Use a dedicated role that does not
  own the tables and has only the grants it needs.
- **Or force RLS on owned tables.** `ALTER TABLE todos FORCE ROW LEVEL SECURITY` applies
  policies to the table owner too. Superusers and `BYPASSRLS` roles are still exempt.
- **Enable RLS and write policies.** A table without `ENABLE ROW LEVEL SECURITY` ignores
  its policies. With RLS enabled and no matching policy, all access is denied.
- **Cover every operation the connector issues.** PUT is an upsert, so it needs
  `INSERT` and `UPDATE` policies. PATCH needs `UPDATE`, and DELETE needs `DELETE`.
  Include `WITH CHECK` so writes cannot assign rows to another user.
- **Coming from PostgREST.** The Express backend sets the single JSON value that PostgREST v10 and
  later use. Policies written for older versions, which read per-claim settings such as
  `request.jwt.claim.sub`, need updating. The Express backend does not switch roles, so connect as a
  role that has the table grants and is subject to RLS, not as PostgREST's `authenticator`
  login role, which typically has no table grants of its own.

Example:

```sql
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY todos_owner ON todos
  USING (owner_id = app_auth.uid())
  WITH CHECK (owner_id = app_auth.uid());

CREATE ROLE api_writer LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO api_writer;
GRANT USAGE ON SCHEMA app_auth TO api_writer;
```

Adjust the column and type casts to your schema. If `owner_id` is a `uuid`, compare with
`app_auth.uid()::uuid`.
