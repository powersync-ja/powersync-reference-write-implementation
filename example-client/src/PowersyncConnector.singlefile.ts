// PowerSync Write API connector
//
// Copy this file into your app to upload queued transactions with plain fetch.
// It requires @powersync/web or @powersync/react-native >=1.26.0 for getCrudTransactions().
// For the modular version, see PowersyncConnector.ts and library/powersync/.
//
// Set BACKEND_URL, POWERSYNC_URL and AUTH_TOKEN below. Adjust the batch limits, request timeout,
// and localStorage key as needed, or connect these constants to your application's configuration.
//
// The default fetchCredentials() uses the fixed AUTH_TOKEN for sync and reuses it for writes.
// The write API accepts tokens your PowerSync instance trusts. Replace fetchAuthToken() with your
// identity provider's token retrieval. Sync and writes should identify the same user.
//
// Setup references:
// https://docs.powersync.com/configuration/app-backend/client-side-integration#backend-connector
// See docs/auth-verifiers.md in this repository for Supabase and Clerk examples.

import type { AbstractPowerSyncDatabase, CrudEntry, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';

// Configuration

/** Base URL of your write API, e.g. `http://localhost:6060` in local dev. */
const BACKEND_URL = 'http://localhost:6060';

/** Your PowerSync instance's sync endpoint. */
const POWERSYNC_URL = '';

/**
 * Token for sync and writes, e.g. a session token copied from your auth provider. Replace
 * fetchAuthToken() with your provider's token retrieval instead of hardcoding one.
 */
const AUTH_TOKEN = '';

/** localStorage key used to persist the anonymous user id across reloads. */
const USER_ID_STORAGE_KEY = 'ps_user_id';

/** Transactions per upload request. Defaults to one transaction per attempt. */
const MAX_TRANSACTIONS_PER_BATCH = 1;

/** Upper bound on total CRUD operations per upload request, regardless of transaction count. */
const MAX_OPERATIONS_PER_BATCH = 1000;

/** Abort a write API request that takes longer than this many milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

// Connector implementation; supporting types and helpers follow the class.

export class PowersyncConnector implements PowerSyncBackendConnector {
  // Called by PowerSync to upload queued local changes to the write API.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batching = this.getBatchingConfig();
    return this.uploadTransactionBatch(database, batching);
  }

  // Returns credentials for the PowerSync sync connection, reusing the write API token.
  // The write API accepts tokens your PowerSync instance trusts. See docs/auth-verifiers.md.
  async fetchCredentials() {
    return {
      endpoint: POWERSYNC_URL,
      token: await this.getAuthToken()
    };
  }

  readonly userId: string;
  private _authToken: string | null;

  constructor() {
    // Provide a crypto.randomUUID() polyfill or a platform UUID generator where unavailable,
    // including older React Native environments.
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = crypto.randomUUID();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._authToken = null;
  }

  // Replace with your auth provider's session token (e.g. Supabase `session.access_token`).
  private async fetchAuthToken(): Promise<string> {
    if (!AUTH_TOKEN) {
      throw new Error('No auth token. Set AUTH_TOKEN or replace fetchAuthToken().');
    }
    return AUTH_TOKEN;
  }

  /**
   * Returns the cached token shared by sync and write requests.
   * Fetches a token on first use or after {@link onTransportError} clears the cache.
   */
  private async getAuthToken(): Promise<string> {
    if (!this._authToken) {
      this._authToken = await this.fetchAuthToken();
    }
    return this._authToken;
  }

  /**
   * The batching config to use for the current upload. Reads the consts at the top of this file;
   * override to make batching dynamic (e.g. shrink batch size after a fatal error, adjust for
   * network conditions).
   */
  protected getBatchingConfig() {
    return {
      maxTransactions: MAX_TRANSACTIONS_PER_BATCH,
      maxOperations: MAX_OPERATIONS_PER_BATCH
    };
  }

  /**
   * Called only for client-directed fatal errors. Retaining blocks later uploads and may call
   * this hook again. Return 'complete' to explicitly discard the failed transaction.
   * See docs/error-handling.md for user interaction and notification deduplication guidance.
   */
  protected async onFatalTransaction(
    transaction: CrudTransaction,
    result: ClientHandledFatalResult
  ): Promise<'retain' | 'complete'> {
    console.error('Client handling required:', result.failedOperation.error_code, result.message);
    return 'retain';
  }

  /**
   * Handles a backend `retryable_error` result. Waits for retryAfterMs, if supplied,
   * then throws so PowerSync retains the transaction and retries the upload.
   * Overrides must also throw to keep the transaction queued.
   */
  protected async onRetryableError(result: Extract<TransactionResult, { status: 'retryable_error' }>): Promise<never> {
    await sleep(result.retryAfterMs ?? 0);
    throw new Error(result.message ?? 'Retryable error');
  }

  /**
   * Handles network errors, timeouts, and non-2xx responses through {@link onRetryableError}.
   * Clears the cached token on {@link AuthenticationError} so the next upload fetches a new one.
   * Override to handle transport failures separately from backend retryable results.
   */
  protected async onTransportError(error: unknown): Promise<never> {
    if (error instanceof AuthenticationError) {
      this._authToken = null;
    }

    const message = error instanceof Error ? error.message : String(error);
    return this.onRetryableError({ status: 'retryable_error', message });
  }

  /**
   * POST /api/data via plain fetch — no openapi-fetch, no generated client. Every non-2xx response
   * this backend returns (400/401/500) is `{ message }` (see backend/powersync-reference-write-api.openapi.yaml); 401/403 become
   * an {@link AuthenticationError} so onTransportError can clear the cached token and retry.
   */
  private async postTransactionBatch(body: TransactionBatchAPI): Promise<TransactionBatchResponseAPI> {
    const response = await fetch(`${BACKEND_URL}/api/data`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${await this.getAuthToken()}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const { message } = (await response.json().catch(() => ({ message: response.statusText }))) as MessageResponseAPI;

      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          `Authentication failed (${response.status}) posting transaction batch: ${message}`
        );
      }
      throw new Error(`Failed to post transaction batch (${response.status}): ${message}`);
    }

    return response.json();
  }

  private async uploadTransactionBatch(
    database: AbstractPowerSyncDatabase,
    batching: ReturnType<PowersyncConnector['getBatchingConfig']>
  ): Promise<void> {
    const batch: CrudTransaction[] = [];
    let operations = 0;

    for await (const transaction of database.getCrudTransactions()) {
      // Take the transaction, then test the bounds. Testing first would either split a transaction
      // that alone exceeds maxOperations, or stall the queue on it forever.
      batch.push(transaction);
      operations += transaction.crud.length;

      if (batch.length >= batching.maxTransactions || operations >= batching.maxOperations) {
        break;
      }
    }

    if (batch.length === 0) return;

    const body: TransactionBatchAPI = {
      transactions: batch.map(toApiTransaction)
    };

    let results: TransactionResult[];
    try {
      const response = await this.postTransactionBatch(body);
      results = response.results.map(toResult);
    } catch (error) {
      await this.onTransportError(error);
      return;
    }

    await completeAcceptedPrefix(
      batch,
      results,
      (index, result) => this.onFatalTransaction(batch[index], result),
      (result) => this.onRetryableError(result)
    );
  }
}

// API types matching backend/powersync-reference-write-api.openapi.yaml. Update these when the API contract changes;
// this file does not use generated types.

type CrudOp = 'PUT' | 'PATCH' | 'DELETE';

interface CrudEntryAPI {
  id: string;
  op: CrudOp;
  table: string;
  transaction_id?: number;
  op_data?: Record<string, unknown>;
}

interface CrudTransactionAPI {
  crud: CrudEntryAPI[];
  transaction_id?: number;
}

interface TransactionBatchAPI {
  transactions: CrudTransactionAPI[];
}

/** `not_attempted` means the batch ended before this transaction was reached. */
type TransactionStatus = 'success' | 'retryable_error' | 'fatal_error' | 'not_attempted';

/** Machine-readable classification of a fatal failure, backend-specific. */
type ErrorCode =
  | 'NOT_NULL_VIOLATION'
  | 'UNIQUE_VIOLATION'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_DATA'
  | 'SCHEMA_MISMATCH'
  | 'DOCUMENT_VALIDATION_FAILURE'
  | 'UNAUTHORIZED'
  | 'UNCLASSIFIED_ERROR'
  | (string & {});

interface FailedOperationAPI {
  error_code: ErrorCode;
  details?: unknown;
  operation_index?: number;
  message?: string;
}

type TransactionResponseAPI =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retry_after_ms?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requires_client_handling: boolean;
      failed_operation: FailedOperationAPI;
    };

/** One result per transaction sent, in the same order and always the same length as the request. */
interface TransactionBatchResponseAPI {
  results: TransactionResponseAPI[];
}

/** `{ message }` — the shape of every non-2xx response this backend returns (400/401/500). */
interface MessageResponseAPI {
  message: string;
}

// Internal (camelCase) result shape passed to the overridable hooks above.

type TransactionResult =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retryAfterMs?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requiresClientHandling: boolean;
      failedOperation: FailedOperationAPI;
    };

type ClientHandledFatalResult = Extract<TransactionResult, { status: 'fatal_error' }> & {
  requiresClientHandling: true;
};

/** Thrown when the backend rejects a request as unauthenticated/unauthorized (401/403). */
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Complete only the contiguous accepted prefix, even when a callback throws. */
async function completeAcceptedPrefix(
  batch: { complete(): Promise<void> }[],
  results: TransactionResult[],
  onFatal: (index: number, result: ClientHandledFatalResult) => Promise<'retain' | 'complete'>,
  onRetryable: (result: Extract<TransactionResult, { status: 'retryable_error' }>) => Promise<never>
): Promise<void> {
  if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Invalid batch result count');
  let boundary = -1;
  try {
    for (const [index, result] of results.entries()) {
      if (result?.status === 'success') {
        boundary = index;
        continue;
      }
      if (result?.status === 'fatal_error') {
        if (
          typeof result.requiresClientHandling !== 'boolean' ||
          !result.failedOperation ||
          typeof result.failedOperation.error_code !== 'string' ||
          (result.failedOperation.message !== undefined && typeof result.failedOperation.message !== 'string') ||
          (result.failedOperation.operation_index !== undefined &&
            (!Number.isInteger(result.failedOperation.operation_index) || result.failedOperation.operation_index < 0))
        ) {
          throw new Error('Malformed fatal transaction result');
        }
        if (result.requiresClientHandling) {
          const decision = await onFatal(index, {
            ...result,
            requiresClientHandling: true
          });
          if (decision !== 'complete') throw new Error('Fatal transaction retained for client handling');
          boundary = index;
          // Client-directed failures always end the backend batch. Never complete a later result.
          return;
        }
        boundary = index;
        continue;
      }
      if (result?.status === 'retryable_error') {
        // Complete the accepted prefix before invoking backoff/retry hooks.
        if (boundary >= 0) {
          const accepted = boundary;
          boundary = -1;
          await batch[accepted].complete();
        }
        await onRetryable(result);
        throw new Error('Retryable transaction retained');
      }
      if (result?.status === 'not_attempted') return;
      throw new Error('Malformed transaction result');
    }
  } finally {
    if (boundary >= 0) await batch[boundary].complete();
  }
}

/** Shape one SDK transaction for the wire. */
const toApiTransaction = (transaction: CrudTransaction): CrudTransactionAPI => ({
  crud: transaction.crud.map((op: CrudEntry) => ({
    id: op.id,
    op: op.op as CrudOp,
    table: op.table,
    ...(op.transactionId != null && { transaction_id: op.transactionId }),
    ...(op.opData != null && { op_data: op.opData })
  })),
  ...(transaction.transactionId != null && {
    transaction_id: transaction.transactionId
  })
});

const toResult = (response: TransactionResponseAPI): TransactionResult => {
  if (response?.status === 'fatal_error')
    return {
      status: response.status,
      message: response.message,
      requiresClientHandling: response.requires_client_handling,
      failedOperation: response.failed_operation
    };
  if (response?.status === 'retryable_error')
    return {
      status: response.status,
      message: response.message,
      retryAfterMs: response.retry_after_ms
    };
  return response;
};
