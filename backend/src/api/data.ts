import config from '../../config.js';
import { fatalErrorHandler, notifyDeadLetter, type FatalErrorContext } from '../fatal-error-handler.js';
import express, { type Request, type Response } from 'express';
import { getPersister } from '../persistence/persister.js';
import { authorizer } from '../auth/authorizer.js';
import { FatalOperationError, RetryableError } from '../errors.js';
import type { AuthContext } from '../auth/types.js';
import type { OpBody, OpResponse, TransactionResult } from '../types.js';

const router = express.Router();

/**
 * Apply one transaction and classify the outcome.
 */
const applyTransaction = async (
  transaction: FatalErrorContext['transaction'],
  auth: AuthContext
): Promise<TransactionResult> => {
  try {
    const allowed = await authorizer.authorize(transaction.crud, auth);
    if (!allowed) {
      throw new FatalOperationError('UNAUTHORIZED', 'Not authorized to apply this transaction');
    }

    const { updateBatch } = await getPersister();
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
      requiresClientHandling = await fatalErrorHandler.requiresClientHandling(error, context);
      if (typeof requiresClientHandling !== 'boolean') throw new Error('Invalid fatal error routing decision');
    } catch (failure) {
      console.error('Fatal error classification failed:', failure);
      return { status: 'retryable_error', message: 'Fatal error routing failed; retry the transaction' };
    }
    if (!requiresClientHandling) notifyDeadLetter(error, context);
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

/**
 * Applies uploaded transactions in queue order, each in its own database transaction.
 * Stops at the first failure unless BATCH_ON_FATAL_ERROR is skip and the failure is a
 * backend-directed fatal error. Client-directed and retryable failures stop the batch.
 * Returns one result per transaction in request order, including not_attempted entries.
 */
router.post(
  '/',
  async (
    req: Request<{}, OpResponse<'postTransactionBatch'>, OpBody<'postTransactionBatch'>>,
    res: Response<OpResponse<'postTransactionBatch'>>
  ) => {
    // Verified identity from the token
    console.log(`Write authenticated as ${req.auth?.sub}`);

    const { transactions } = req.body;
    const onFatalError = config.batchOnFatalError;
    const results: TransactionResult[] = [];

    for (const transaction of transactions) {
      const result = await applyTransaction(transaction, req.auth!);
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

    res.status(200).send({ results });
  }
);

export { router as dataRouter };
