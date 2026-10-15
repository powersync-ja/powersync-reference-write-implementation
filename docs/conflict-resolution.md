# Conflict resolution

How this backend resolves conflicts between client writes today.

## Summary

The backend has **no conflict detection**. It applies each uploaded operation to the source database in the order received. 

No versions, timestamps, or comparison against existing row state are used. That produces:

| Situation | Outcome | Rule |
| --- | --- | --- |
| Two clients update the same column | Later-arriving write wins | Last write wins (LWW) |
| Two clients update different columns of the same row | Both changes kept | LWW per column |
| One client updates (`PATCH`) a row another client deleted | Update is silently dropped, row stays deleted | Delete wins |
| One client deletes a row another client updated | Row deleted | Delete wins |
| One client **inserts / replaces** (`PUT`) a row with an id another client deleted | Row is **re-created** | Not delete wins |
| Delete of a row that does not exist | No-op, no error | Idempotent |

The summary is that "deletes win and last write wins" with two caveats:

1. "Last" means **arrival order at the backend**, not the time the user made the edit.
2. Delete wins only against `PATCH`. A `PUT` on a deleted id recreates the row.

## Per-operation behaviour

Behaviour is the same on Postgres, MySQL, and MSSQL unless stated otherwise.

### `PUT`: upsert, provided columns overwritten

- Row missing: inserted (this is the delete-resurrection case).
- Row exists: columns present in the `PUT` are overwritten, others left untouched.

**MongoDB differs**: `replaceOne` replaces the whole document, so fields not in the `PUT` are dropped.

### `PATCH`: update existing row only

- Row missing: matches zero rows, no error, no insert. This is the "delete wins" path.
- Row exists: only the changed columns are written, so concurrent edits to different columns merge.
- Concurrent edits to a single column: last edit will win
- Empty column list (id only): skipped.

### `DELETE` — hard delete

- Missing row is a no-op.
- There are no soft-delete flags. The row is gone and the sync service propagates the removal to other clients.

## Client visibility on conflicts

The client applies its writes locally first, then uploads. After upload, the next sync from the source database replaces local state with whatever the backend committed.

A losing client's edit therefore appears to "revert" once sync catches up. There is no notification that a write was lost or overwritten due to conflict.

## Constraint failures

Concurrent operations by different clients may result in constraint failures (unique, foreign key, not-null, check).

These will abort the transaction and are classified as fatal or retryable errors. They are not resolved automatically. See [error-handling.md](error-handling.md).

## Limitations of the current approach

- Arrival order, not edit time, decides the winner. Offline clients can overwrite newer data.
- No visibility of lost writes: no audit trail, no conflict log.
- `PUT` can resurrect deleted rows. Clients that re-insert with a known id (e.g. `INSERT OR REPLACE`) will undo another client's delete.
- Per-column last-write-wins can produce combinations no single user intended (client A's `title` with client B's `status`).
- MongoDB `PUT` is whole-document replace, unlike the SQL adapters.

# Alternatives

PowerSync documents a set of custom conflict resolution strategies, with Postgres schema, client and Node.js backend examples, in [Custom Conflict Resolution](https://docs.powersync.com/handling-writes/custom-conflict-resolution). That page is the canonical reference; this section only lists what exists.

| Strategy | Idea |
| --- | --- |
| Timestamp-based detection | Reject a write if the row's `modified_at` is newer than the client's. |
| Sequence number versioning | Client sends the version it last saw; reject on mismatch. Avoids clock skew but cannot merge edits. |
| Field-level last write wins | Per-field timestamps (sent via `_metadata`); apply only fields the client changed more recently. |
| Business rule validation | Check server state against domain rules (locked records, allowed status transitions). Validates; does not detect concurrency. |
| Server-side conflict recording | Store both versions in a conflicts table and let a user resolve. |
| Change-level status tracking | Record each change as `pending`, `applied` or `failed` so the client can show and retry. |
| Cumulative operations | Apply deltas (e.g. inventory `quantity - 1`) instead of overwriting values. |

For collaborative documents, the page points to CRDTs.

### Applying them in this backend

- **Metadata and previous values are dropped.** The API accepts `metadata` and `previous_values` on each `CrudEntry`, but the mappers and persisters forward only `table`, `op`, `id` and `data`. Field-level LWW, delta detection and anything comparing against previous values need those passed through first.
- **Rejecting a write** (stale version, failed rule) maps to a `FatalOperationError`. See [error-handling.md](error-handling.md) for routing.
- **Idempotency.** The PowerSync page recommends deduplicating by client and operation id. This backend instead relies on `PUT`, `PATCH` and `DELETE` being naturally idempotent, so any strategy added here must keep retries of an already-committed transaction safe.
