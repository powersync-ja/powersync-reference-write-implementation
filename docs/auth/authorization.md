# Authorization

Authentication identifies the caller. Authorization determines which writes the
caller may make. The default authorizer allows all authenticated writes.

## Authorization hook

`backend/src/auth/authorizer.ts` exports an `Authorizer`, called once per transaction
by `backend/src/api/data.ts` before persistence:

```ts
export interface Authorizer {
  authorize(crud: CrudEntry[], auth: AuthContext): boolean | Promise<boolean>;
}
```

`crud` contains the operations sent by the client. `auth` contains the verified token
subject and claims: `{ sub, claims }`.

Returning `false` rejects the whole transaction with `UNAUTHORIZED`. The default
[fatal-error handler](../error-handling.md) treats this as client-directed: the transaction stays
queued on the client and is retried, so a denied write is not lost. It blocks later uploads
until the permission is granted or the app's `onFatalTransaction` hook releases it. To drop
denied writes instead, change `requiresClientHandling` in `backend/src/fatal-error-handler.ts`.

Replace `authorizer` with your application's checks, such as table permissions or
required roles. The default implementation logs this message on every call:

```
Authorization is not configured. All authenticated writes are allowed. Configure backend/src/auth/authorizer.ts; see docs/auth/authorization.md.
```

## Checking existing rows

The hook receives the uploaded operations and verified identity. The `Persister`
interface provides no method for reading existing rows. Checks that depend on a row's
current owner should run inside the persister's database transaction.

Use `authorize()` for checks that need no database lookup. For example, an application
that accepts writes only to `lists` and `todos` could use:

```ts
// Replace the existing export in backend/src/auth/authorizer.ts.
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

`createPostgresPersister` sets `app.user_id` from the verified subject at the start of
each transaction:

```ts
await client.query('SELECT set_config($1, $2, true)', ['app.user_id', auth.sub]);
```

The `true` argument scopes the setting to that transaction. Your row-level security
policies can read it with `current_setting('app.user_id', true)`.

**N.B. This backend sets the
identity value but does not create policies.** You must define and enable policies for your schema and database role. 

### Requirements for policies to take effect

- **Connect as a non-owner role.** Table owners, superusers, and roles with `BYPASSRLS`
  skip row-level security. If `DATABASE_URI` connects as one of these, policies are
  silently ignored and `app.user_id` has no effect. Use a dedicated role that does not
  own the tables and has only the grants it needs.
- **Or force RLS on owned tables.** `ALTER TABLE todos FORCE ROW LEVEL SECURITY` applies
  policies to the table owner too. Superusers and `BYPASSRLS` roles are still exempt.
- **Enable RLS and write policies.** A table without `ENABLE ROW LEVEL SECURITY` ignores
  its policies. With RLS enabled and no matching policy, all access is denied.
- **Cover every operation the connector issues.** PUT is an upsert, so it needs
  `INSERT` and `UPDATE` policies. PATCH needs `UPDATE`, and DELETE needs `DELETE`.
  Include `WITH CHECK` so writes cannot assign rows to another user.

Example:

```sql
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY todos_owner ON todos
  USING (owner_id = current_setting('app.user_id', true))
  WITH CHECK (owner_id = current_setting('app.user_id', true));

CREATE ROLE api_writer LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO api_writer;
```

Adjust the column and type casts to your schema. If `owner_id` is a `uuid`, compare with
`current_setting('app.user_id', true)::uuid`.
