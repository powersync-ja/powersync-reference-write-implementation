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

The factories are configured in `backend/src/persistence/persister-factories.ts`.

## Default mapping

Postgres, MySQL, and SQL Server use `defaultMapper`. It preserves table and field
names without converting or validating values, and logs this on every call. The row ID
is taken from `entry.id` (falling back to `op_data.id`) and removed from the remaining fields.
Replace it if your client and database schemas differ.

MongoDB uses `createMongoMapper`. At startup, `discoverSchema` reads collection
`$jsonSchema` validators through `db.listCollections()` and builds field type
converters. See `backend/src/persistence/mongo/mongo-schema.ts`.

With the default MongoDB mapper, a write to a collection without a discovered validator
fails with `SCHEMA_MISMATCH`. The error includes the original operation index, and the
whole transaction is rolled back. The shared [fatal-error handler](error-handling.md)
routes the failure. A custom mapper handles its own schema mapping.

Add a `$jsonSchema` validator for each collection that accepts writes through the
default mapper. Restart the backend after adding or changing validators.

## Custom mapping

- **Rename tables or fields.** Return a different `table` or change the keys in `data`.
- **Convert values.** Use a converter for fields whose JSON values differ from the
  database type, such as timestamps or booleans. See `applySchema` in `mongo-schema.ts`.
- **Set server-controlled fields.** Add or overwrite values such as `updated_at`.
  For ownership fields such as `owner_id` and `created_by`, see
  [authorization](authorization.md). The mapper does not receive the verified identity.
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

### Do not wrap `defaultMapper`

`defaultMapper` logs an error on every call to warn that nothing is renamed or validated.
A mapper that calls it prints that warning for every operation, even though it does map.
Copy its few lines of ID and field handling instead.

### Example: rename a table and a column

```ts
// backend/src/mapping/renames.ts
import type { EntryMapper } from './types.js';

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

Factories take `(uri, mapper?)` and are stored in a record, so wrap the one you want. Edit
`backend/src/persistance/persister-factories.ts`:

```ts
import { renamingMapper } from '../mapping/renames.js';

export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: (uri) => createMySQLPersister(uri, renamingMapper),
  mssql: createMSSQLPersister
};
```

Rebuild the image (`docker compose up --build`) because the TypeScript is compiled into it. Each
engine's factory needs its own change.

### MongoDB

Passing a mapper to `createMongoPersister` skips `discoverSchema`, so your mapper must do any
type conversion that the default MongoDB mapper would have derived from the `$jsonSchema`
validators.

### Failures you will see without a mapper

A client table or column that does not exist in the source fails as a `SCHEMA_MISMATCH` fatal
error (for example `Table 'db.expanded_todos' doesn't exist`), reported with the index of the
failing operation, and the whole transaction is rolled back. See [error handling](error-handling.md).

## Database lookups and multiple writes

`EntryMapper` supports synchronous, one-to-one transformations. It cannot perform
asynchronous database lookups or return writes to multiple tables or documents.

Implement those operations in the relevant persister's `updateBatch` method under
`backend/src/persistence/<database>/`, using its database connection and transaction.
