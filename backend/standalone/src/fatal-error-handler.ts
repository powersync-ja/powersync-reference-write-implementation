import { deliverDeadLetter, type FatalErrorContext, type FatalErrorHandler } from '../../shared/src/write/dead-letter.ts';
import type { FatalOperationError } from '../../shared/src/errors.ts';

export type { DeadLetterEntry, FatalErrorContext, FatalErrorHandler } from '../../shared/src/write/dead-letter.ts';

/**
 * Replace these methods with application routing and developer-owned storage/notifications.
 * Authorization rejections stay queued on the client rather than being dropped, so a write
 * denied by a misconfigured or not-yet-granted permission is not lost.
 */
export const fatalErrorHandler: FatalErrorHandler = {
  requiresClientHandling: (error) => error.errorCode === 'UNAUTHORIZED',
  onDeadLetter(entry) {
    console.error(
      'Fatal transaction rejected. Configure backend/standalone/src/fatal-error-handler.ts; see docs/error-handling.md.',
      entry
    );
  }
};

/** Logs callback failures without changing the transaction result. Returned promises are not awaited. */
export function notifyDeadLetter(error: FatalOperationError, context: FatalErrorContext): void {
  void deliverDeadLetter(fatalErrorHandler, error, context);
}
