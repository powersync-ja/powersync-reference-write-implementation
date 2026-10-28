import { FatalOperationError, RetryableError } from '../errors.ts';
import { deliverDeadLetter, type FatalErrorContext, type FatalErrorHandler } from './dead-letter.ts';
import { assertSafeTransaction } from '../persistence/identifiers.ts';
import type { AuthContext, Authorizer, OpBody, Persister, TransactionResult } from '../types.ts';

export type BatchOnFatalError = 'stop' | 'skip';
export type UploadedTransaction = FatalErrorContext['transaction'];
export type TransactionBatch = OpBody<'postTransactionBatch'>['transactions'];

export interface TransactionProcessorOptions {
  /** Resolved for each transaction, so a failure to create the persister is reported per transaction. */
  persister: () => Persister | Promise<Persister>;
  authorizer: Authorizer;
  fatalErrorHandler: FatalErrorHandler;
  /** Read once per batch. */
  batchOnFatalError: () => BatchOnFatalError;
  /**
   * Wait for the dead-letter handler before returning a result. Leave false where the process
   * outlives the response (Node). Set true where work may be dropped after the response (Edge).
   */
  awaitDeadLetter?: boolean;
}

export type TransactionProcessor = (transactions: TransactionBatch, auth: AuthContext) => Promise<TransactionResult[]>;

/**
 * Creates a processor that applies uploaded transactions in queue order, each in its own database
 * transaction. It stops at the first failure unless the batch policy is skip and the failure is a
 * backend-directed fatal error. Client-directed and retryable failures stop the batch. It returns
 * one result per transaction in request order, including not_attempted entries.
 */
export function createTransactionProcessor(options: TransactionProcessorOptions): TransactionProcessor {
  const applyTransaction = async (transaction: UploadedTransaction, auth: AuthContext): Promise<TransactionResult> => {
    try {
      // Rejects unsafe client table and column names before any database work, whichever
      // persister runs. See docs/schema-mapping.md#identifier-validation.
      assertSafeTransaction(transaction.crud);

      // Authorizes the transaction before applying it. This depends on
      // application business logic and may involve checking user roles, permissions, or other criteria.
      const allowed = await options.authorizer.authorize(transaction.crud, auth);
      if (!allowed) {
        throw new FatalOperationError('UNAUTHORIZED', 'Not authorized to apply this transaction');
      }

      // Applies the transaction using the persister. This is where the actual database operations occur.
      const { updateBatch } = await options.persister();
      await updateBatch(transaction.crud, auth);
      return { status: 'success' };
    } catch (e) {
      if (e instanceof RetryableError) return { status: 'retryable_error', message: e.message };
      const error =
        e instanceof FatalOperationError
          ? e
          : new FatalOperationError('UNCLASSIFIED_ERROR', e instanceof Error ? e.message : String(e));
      const context = { transaction, auth };
      let requiresClientHandling: boolean;
      try {
        requiresClientHandling = await options.fatalErrorHandler.requiresClientHandling(error, context);
        if (typeof requiresClientHandling !== 'boolean') throw new Error('Invalid fatal error routing decision');
      } catch (failure) {
        console.error('Fatal error classification failed:', failure);
        return { status: 'retryable_error', message: 'Fatal error routing failed; retry the transaction' };
      }
      if (!requiresClientHandling) {
        const delivery = deliverDeadLetter(options.fatalErrorHandler, error, context);
        if (options.awaitDeadLetter) await delivery;
      }
      return {
        status: 'fatal_error',
        requires_client_handling: requiresClientHandling,
        message: error.message,
        failed_operation: {
          error_code: error.errorCode,
          message: error.message,
          details: error.details,
          operation_index: error.operationIndex
        }
      };
    }
  };

  return async (transactions, auth) => {
    const onFatalError = options.batchOnFatalError();
    const results: TransactionResult[] = [];

    for (const transaction of transactions) {
      const result = await applyTransaction(transaction, auth);
      results.push(result);

      if (result.status === 'success') {
        continue;
      }

      // Skipping covers fatal failures only. A retryable failure ends the batch.
      const skipping = result.status === 'fatal_error' && !result.requires_client_handling && onFatalError === 'skip';

      if (!skipping) {
        break;
      }
    }

    while (results.length < transactions.length) {
      results.push({ status: 'not_attempted' });
    }

    return results;
  };
}
