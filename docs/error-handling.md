# Fatal errors and developer-managed dead letters

Every fatal error defaults to backend handling. Replace the methods on
`fatalErrorHandler` in `backend/src/fatal-error-handler.ts` to choose which errors need
client intervention and deliver backend-directed failures to your own storage or service.
Authorization failures reach this handler before persistence starts. If a database transaction
has started, its adapter attempts rollback before the failure reaches this handler.

Postgres connection acquisition failures are classified before routing. Known transient Node
transport failures, such as `ECONNREFUSED` and `ECONNRESET`, return `retryable_error` so the
connector retains queued transactions during outages. Credential failures, constraints and
unknown non-transient codes remain fatal. If acquisition fails, there is no client to roll
back or release; transaction failures still attempt rollback and release the acquired client.

The following replaces `fatalErrorHandler` in `backend/src/fatal-error-handler.ts`.
`developerOwnedStorage` is a placeholder for your storage integration; supply its import and
implementation. The file already declares `FatalErrorHandler`.

```ts
export const fatalErrorHandler: FatalErrorHandler = {
  requiresClientHandling(error, context) {
    // Choose which rejected writes need a client decision, such as asking the user
    // to confirm a change or correct invalid input. Return true to keep the write
    // queued for client handling; return false to route it to onDeadLetter.
    return error.errorCode === 'USER_CONFIRMATION_REQUIRED';
  },
  async onDeadLetter(entry) {
    // Called for rejected transactions when requiresClientHandling returns false.
    // Store the entry for investigation or notify your support team, for example.
    // Replace this insert with your own integration; delivery is best effort.
    // The returned promise is not awaited (see delivery behavior below).
    await developerOwnedStorage.insert(entry);
  }
};
```

Import `FatalOperationError` from `backend/src/errors.ts` using the relative path for your
file, then throw an application error from authorization, a mapper, or custom persistence logic:

```ts
throw new FatalOperationError(
  'USER_CONFIRMATION_REQUIRED',
  'Confirm the change before retrying.',
  { record_id: '123' }
);
```

Existing two-argument calls remain valid. Codes can be any application string. `details`
can be any JSON value; the API imposes no application-specific schema. Adapters attach the
zero-based original operation index when a particular operation fails. Transaction-level
failures, including commit failures, have no inferred operation index. Only include details
that the authenticated client should receive.

A `DeadLetterEntry` includes a fresh occurrence ID, ISO timestamp, full original transaction,
verified subject, code, message, optional details and operation index. The whole transaction
is included because the API rejected it as a unit. A connection failure during commit can
leave the database outcome uncertain; investigate that outcome before replaying writes.
The occurrence ID identifies this notification attempt, not a stable transaction deduplication key.

Delivery is best effort. The server invokes `onDeadLetter` without awaiting its promise;
synchronous exceptions and rejected promises are logged, and an unresolved promise does not
block the response. A handler doing synchronous work can still delay the event loop. Delivery
may fail or be lost at shutdown. Repeated uploads can produce duplicate notifications. There
is no built-in persistence, delivery retry, replay API, or deduplication. Implement these in
your own service if required. The default handler logs the entry and points to this guide.
If classification throws or returns an invalid decision, the result is retryable and the
batch stops without sending a dead-letter notification.

## Response and queue behavior

Fatal results require `requires_client_handling` at transaction-result level and
`failed_operation` containing required `error_code` and optional `message`, `details`,
and `operation_index`. Success, retryable and not-attempted results do not carry the routing flag.

| Result | Backend batch | Client queue |
| --- | --- | --- |
| Success | Continue | Complete |
| Fatal, flag false | Honor backend `BATCH_ON_FATAL_ERROR` | Complete |
| Fatal, flag true | Always stop, even with `skip` | Await explicit client decision |
| Retryable | Stop | Retain and retry |
| Not attempted | No execution | Retain |

Configure `BATCH_ON_FATAL_ERROR=stop` (default) or `skip` on the backend. This setting
applies only to backend-directed fatal failures; client-directed and retryable failures
always stop the batch. Restart the backend after changing it (recreate the container when
using Docker Compose). The client cannot override this policy. Older clients may still send
`on_fatal_error`, but it is ignored. Deployments previously requesting `skip` from the client
must now set `BATCH_ON_FATAL_ERROR=skip` on the backend.

Both example connectors expose the same hook. Override it in a subclass or edit your copied
connector. `CrudTransaction` comes from the PowerSync SDK; `ClientHandledFatalResult` is exported
by the modular `WriteAPIClient.ts` and declared locally in the single-file connector:

```ts
protected async onFatalTransaction(
  transaction: CrudTransaction,
  result: ClientHandledFatalResult
): Promise<'retain' | 'complete'> {
  if (result.failedOperation.error_code === 'USER_CONFIRMATION_REQUIRED') {
    const details = result.failedOperation.details;
    // Validate your application's details shape, then record/display the pending decision.
    // Deduplicate notifications in your application: this hook can run again on every retry.
    console.info('Confirmation required', details);
  }
  return 'retain';
}
```

The hook runs only for client-directed errors. The default logs the error and retains the
transaction. Returning
`'complete'` explicitly releases/discards the failed transaction; it does **not** mean the
source write succeeded. Returning `'retain'`, an invalid value, or throwing keeps it queued
and throws from the upload attempt so PowerSync can retry. A malformed fatal response,
including a missing flag, also retains the transaction.

Only consecutive transactions from the start of the batch that may leave the queue are
completed. This includes successful writes, backend-directed fatal failures, and client-directed
failures released with `complete`. Earlier accepted transactions are completed even if a later
callback fails.
[PowerSync transaction completion also completes earlier transactions from the iterator](https://powersync-ja.github.io/powersync-js/common/interfaces/CommonPowerSyncDatabase#getcrudtransactions),
so a later success must never complete across a retained transaction.

A retained transaction blocks later uploads. A corrective write queued behind it cannot
unblock it by itself. For a replacement workflow, capture the user's intended correction
in application-owned state, get their decision, explicitly release the failed transaction,
and then submit the replacement. Account for crashes between release and replacement in
your application if that intent must survive them. Your application supplies the UI, avoids
duplicate notifications, and decides when to release or replace a rejected transaction. Returning `complete` removes that write from the queue.
