import type { CrudEntry as SDKCrudEntry, CrudTransaction } from '@powersync/web';

export interface CrudTransaction_API {
  crud: CrudEntry_API[];
  transaction_id?: number;
}

export interface CrudEntry_API {
  id: string;
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  transaction_id?: number;
  op_data?: Record<string, unknown>;
}

export interface TransactionBatch_API {
  transactions: CrudTransaction_API[];
}

/** `not_attempted` means the batch ended before this transaction was reached. */
export type TransactionStatus = 'success' | 'retryable_error' | 'fatal_error' | 'not_attempted';

export interface FailedOperation_API {
  error_code: string;
  details?: unknown;
  operation_index?: number;
  message?: string;
}

export type TransactionResponse =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retry_after_ms?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requires_client_handling: boolean;
      failed_operation: FailedOperation_API;
    };

/** One result per transaction sent, in the same order and always the same length as the request. */
export interface TransactionBatchResponse {
  results: TransactionResponse[];
}

export interface WriteAPITransport {
  postTransactionBatch(body: TransactionBatch_API): Promise<TransactionBatchResponse>;
}

export type TransactionResult =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retryAfterMs?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requiresClientHandling: boolean;
      failedOperation: FailedOperation_API;
    };

export type ClientHandledFatalResult = Extract<TransactionResult, { status: 'fatal_error' }> & {
  requiresClientHandling: true;
};

export interface TransactionBatchResult {
  results: TransactionResult[];
}

export interface WriteAPIClientOptions {
  transport: WriteAPITransport;
  userId: string;
  clientId: string;
}

export interface IWriteAPIClient {
  processTransactionBatch(transactions: CrudTransaction[]): Promise<TransactionBatchResult>;
}

/** Converts an SDK transaction to the API request format. */
const toApiTransaction = (transaction: CrudTransaction): CrudTransaction_API => ({
  crud: transaction.crud.map((op: SDKCrudEntry) => ({
    id: op.id,
    op: op.op as 'PUT' | 'PATCH' | 'DELETE',
    table: op.table,
    ...(op.transactionId != null && { transaction_id: op.transactionId }),
    ...(op.opData != null && { op_data: op.opData })
  })),
  ...(transaction.transactionId != null && {
    transaction_id: transaction.transactionId
  })
});

const toResult = (response: TransactionResponse): TransactionResult => {
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

export class WriteAPIClient implements IWriteAPIClient {
  constructor(private options: WriteAPIClientOptions) {}

  /**
   * Uploads complete transactions in one request. The backend processes them in order,
   * each in its own database transaction, and returns one result per transaction.
   */
  async processTransactionBatch(transactions: CrudTransaction[]): Promise<TransactionBatchResult> {
    const body: TransactionBatch_API = {
      transactions: transactions.map(toApiTransaction)
    };

    const response = await this.options.transport.postTransactionBatch(body);

    return { results: response.results.map(toResult) };
  }
}
