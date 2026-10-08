import { randomUUID } from 'node:crypto';
import type { AuthContext } from './auth/types.js';
import type { components } from './generated/api.js';
import type { FatalOperationError, JsonValue } from './errors.js';

export interface FatalErrorHandler {
  requiresClientHandling(error: FatalOperationError, context: FatalErrorContext): boolean | Promise<boolean>;
  onDeadLetter(entry: DeadLetterEntry): void | Promise<void>;
}

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

export interface FatalErrorContext {
  transaction: components['schemas']['CrudTransaction'];
  auth: AuthContext;
}

export interface DeadLetterEntry {
  occurrenceId: string;
  timestamp: string;
  transaction: FatalErrorContext['transaction'];
  authenticatedSubject: string;
  errorCode: string;
  message: string;
  details?: JsonValue;
  operationIndex?: number;
}

/** Logs callback failures without changing the transaction result. Returned promises are not awaited. */
export function notifyDeadLetter(error: FatalOperationError, context: FatalErrorContext): void {
  try {
    const pending = fatalErrorHandler.onDeadLetter({
      occurrenceId: randomUUID(),
      timestamp: new Date().toISOString(),
      transaction: context.transaction,
      authenticatedSubject: context.auth.sub,
      errorCode: error.errorCode,
      message: error.message,
      details: error.details,
      operationIndex: error.operationIndex
    });
    void Promise.resolve(pending).catch((failure) => console.error('Dead-letter handler failed:', failure));
  } catch (failure) {
    console.error('Dead-letter handler failed:', failure);
  }
}
