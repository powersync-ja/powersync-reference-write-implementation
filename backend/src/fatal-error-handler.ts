import { deliverDeadLetter, type FatalErrorContext, type FatalErrorHandler } from './write/dead-letter.ts';
import type { FatalOperationError } from './errors.ts';

export type { DeadLetterEntry, FatalErrorContext, FatalErrorHandler } from './write/dead-letter.ts';

/** Replace these methods with application routing and developer-owned storage/notifications. */
export const fatalErrorHandler: FatalErrorHandler = {
  requiresClientHandling: () => false,
  onDeadLetter(entry) {
    console.error(
      'Fatal transaction rejected. Configure backend/src/fatal-error-handler.ts; see docs/error-handling.md.',
      entry
    );
  }
};

/** Logs callback failures without changing the transaction result. Returned promises are not awaited. */
export function notifyDeadLetter(error: FatalOperationError, context: FatalErrorContext): void {
  void deliverDeadLetter(fatalErrorHandler, error, context);
}
