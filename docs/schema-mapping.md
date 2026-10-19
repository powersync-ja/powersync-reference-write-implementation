# Schema mapping

Each persister calls an `EntryMapper` before writing a PowerSync `CrudEntry`:

```ts
export type EntryMapper = (entry: CrudEntry) => MappedEntry | null;
```

The mapper runs synchronously inside the database transaction. It returns one
`{ table, op, id, data }` entry, or `null` to skip the operation. Pass a custom mapper
as the second argument to the persister factory:

```ts
createPostgresPersister(uri, myCustomMapper);
```

The factories are configured in `backend/standalone/src/persistence/persister-factories.ts`.

## Row ID

Each table that clients write needs a column named `id` (`_id` in MongoDB) that is the primary
key or has a unique constraint, and holds the client's row ID. The adapters write and match rows
by this column: Postgres upserts with `ON CONFLICT (id)`, and every adapter matches updates and
deletes on it. A mapper can rename tables and other columns but not this one. Tables keyed
differently, such as an integer serial, a column with another name, or a composite key, need a
change to the persister under `backend/shared/src/persistence/<database>/`.

## Identifier validation

Before any persister or mapper runs, the transaction processor
(`backend/shared/src/write/processor.ts`) checks the client-supplied table name and each `op_data` key
against `^[A-Za-z_][A-Za-z0-9_]*$` (at most 63 characters; see
`backend/shared/src/persistence/identifiers.ts`). This applies to every backend, including the
Supabase Edge Function and any persister you install. A name that fails, such as `my-table`, `public.todos`
or `$where`, rejects the transaction with an `INVALID_DATA` fatal error and the operation index.
Rename the client table or column, or accept the plain name and map it to the real one in a
custom mapper. Names a mapper returns are not subject to this check, so a mapper can target
`myschema.todos`; the adapters still escape them.

## Default mapping

Postgres, MySQL, and SQL Server use `defaultMapper`. It preserves table and field
names without converting or validating values, and logs this on every call. The row ID
is taken from `entry.id` (falling back to `op_data.id`) and removed from the remaining fields.
Replace it if your client and database schemas differ. A client table or column that does not
exist in the source fails as a `SCHEMA_MISMATCH` fatal error (for example
`Table 'db.expanded_todos' doesn't exist`), reported with the failing operation's index, and the
whole transaction is rolled back. See [error handling](error-handling.md).

MongoDB uses `createMongoMapper`. At startup, `discoverSchema` reads collection
`$jsonSchema` validators through `db.listCollections()` and builds a [Zod](https://zod.dev)
schema for each collection (`backend/shared/src/persistence/mongo/mongo-schema.ts`). The mapper validates
each write against it and converts client values to BSON types: SQLite `0`/`1` to booleans, and
date strings or epoch numbers to `Date`. Required fields must be present on `PUT`; `PATCH`
needs only the changed fields. Fields the validator does not mention, and types it cannot check
(objects, arrays, ObjectIds), pass through unchanged.

A value that does not match, such as `'abc'` for an `int` field or `'false'` for a `bool`, fails
as an `INVALID_DATA` fatal error. The error names the offending fields in `details`.

With the default MongoDB mapper, a write to a collection without a discovered validator
fails with `SCHEMA_MISMATCH` in the same way. A custom mapper handles its own schema mapping.

Add a `$jsonSchema` validator for each collection that accepts writes through the
default mapper. Restart the backend after adding or changing validators.

## Custom mapping

- **Rename tables or fields.** Return a different `table` or change the keys in `data`.
- **Convert values.** Convert fields whose JSON values differ from the database type, such as
  timestamps or booleans. For MongoDB, see `collectionSchemaFromJsonSchema` in `mongo-schema.ts`.
- **Set server-controlled fields.** Add or overwrite values such as `updated_at`.
  For ownership fields such as `owner_id` and `created_by`, see
  [authorization](auth/authorization.md). The mapper does not receive the verified identity.
- **Remove fields.** Omit fields that the database does not store or clients may not write.

## Writing and installing a custom mapper

### What the mapper receives and must return

- `entry.table` is the **client** table name, exactly as the client's PowerSync schema and
  sync streams name it. A sync stream can serve a source table under a different name
  (`FROM todos AS expanded_todos`) or add alias columns (`title AS fake_title`); uploads use
  those client names, which usually do not exist in the source database.
- `entry.op_data` holds only what the client wrote. For `PATCH` that is **only the changed
  columns**, not the whole row. For `DELETE` it is absent.
- The row ID is `entry.id` (fall back to `op_data.id`). Return it as `id` and leave it **out of
  `data`**: the SQL persisters take the ID from `mapped.id` and ignore an `id` key in `data`.
- A rename is therefore a change to `table` and to the keys of `data`. If two client columns
  can map to the same source column in one `PUT`, decide which wins; the stream may serve the
  same value under both names.

### Example: rename a table and a column

Copy the ID and field handling from `defaultMapper` instead of wrapping it: it logs an error on
every call, which would repeat for every operation even though your mapper does map.

```ts
// backend/standalone/src/mapping/renames.ts (Express; see below for the Edge Function)
import type { EntryMapper } from '../../../shared/src/mapping/types.ts';

// Client table -> source table, and per-table client column -> source column.
const TABLES: Record<string, { table: string; columns: Record<string, string> }> = {
  expanded_todos: { table: 'todos', columns: { fake_title: 'title' } }
};

export const renamingMapper: EntryMapper = (entry) => {
  const rule = TABLES[entry.table];
  const table = rule?.table ?? entry.table;

  const raw = entry.op_data ?? {};
  const id = (entry.id ?? raw.id) as string;
  if (entry.op === 'DELETE') return { table, op: entry.op, id, data: {} };

  const { id: _discardId, ...fields } = raw;
  if (!rule) return { table, op: entry.op, id, data: fields };

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const target = rule.columns[key] ?? key;
    if (target !== key && target in fields) continue; // the source column's own value wins
    data[target] = value;
  }
  return { table, op: entry.op, id, data };
};
```

Return `null` to drop an operation, for example for a client-only table that has no source
table. Skipped operations are not an error.

### Installing it

#### Express backend

Factories take `(uri, mapper?)` and are stored in a record, so wrap the one you want. Edit
`factories` in `backend/standalone/src/persistence/persister-factories.ts`. Identifier validation still
applies, because the transaction processor runs it before any factory's persister:

```ts
import { renamingMapper } from '../mapping/renames.ts';

export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: (uri) => createMySQLPersister(uri, renamingMapper),
  mssql: createMSSQLPersister
};
```

Rebuild the image (`docker compose up --build`) because the TypeScript is compiled into it. Each
engine's factory needs its own change.

#### Supabase Edge Function

Put the mapper in `backend/supabase/functions/powersync-write/` and import the type through the
function's import map, `@powersync/write-core/mapping/types.ts`, instead of the relative path above.
Then export it from `mapper.ts`:

```ts
import { renamingMapper } from './renames.ts';

export const mapper = renamingMapper;
```

Redeploy with `supabase functions deploy powersync-write`. The function uses only the Postgres
adapter, and identifier validation still applies.

### MongoDB

Passing a mapper to `createMongoPersister` skips `discoverSchema`, so your mapper must do any
validation and type conversion that the default MongoDB mapper would have derived from the
`$jsonSchema` validators. You can reuse `collectionSchemaFromJsonSchema` or write your own Zod
schemas.

## Database lookups and multiple writes

`EntryMapper` supports synchronous, one-to-one transformations. It cannot perform
asynchronous database lookups or return writes to multiple tables or documents.

Implement those operations in the relevant persister's `updateBatch` method under
`backend/shared/src/persistence/<database>/`, using its database connection and transaction.
