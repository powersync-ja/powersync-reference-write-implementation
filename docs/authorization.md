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

Returning `false` rejects the whole transaction with `UNAUTHORIZED`. The
[fatal-error handler](error-handling.md) determines whether the client retains it.
Client-directed failures remain queued until the application decides how to handle them.

Replace `authorizer` with your application's checks, such as table permissions or
required roles. The default implementation logs this message on every call:

```
Authorization is not configured. All authenticated writes are allowed. Configure backend/src/auth/authorizer.ts; see docs/authorization.md.
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

`createPostgresPersister` sets `app.user_id` from the verified subject at the start of
each transaction:

```ts
await client.query('SELECT set_config($1, $2, true)', ['app.user_id', auth.sub]);
```

The `true` argument scopes the setting to that transaction. Your row-level security
policies can read it with `current_setting('app.user_id', true)`.

Define and enable policies for your schema and database role. This backend sets the
identity value but does not create policies.
