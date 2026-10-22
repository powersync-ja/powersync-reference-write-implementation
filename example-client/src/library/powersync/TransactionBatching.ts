import type { TransactionResult, ClientHandledFatalResult } from './WriteAPIClient';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Complete only the contiguous accepted prefix, even when a callback throws. */
export async function completeAcceptedPrefix(
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
