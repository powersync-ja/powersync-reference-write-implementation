import type { AuthContext } from '../auth/types.ts';
import type { components } from '../generated/api.ts';
import type { FatalOperationError, JsonValue } from '../errors.ts';

export interface FatalErrorHandler {
  requiresClientHandling(error: FatalOperationError, context: FatalErrorContext): boolean | Promise<boolean>;
  onDeadLetter(entry: DeadLetterEntry): void | Promise<void>;
}

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

/**
 * Calls the dead-letter handler and resolves once it settles. Handler failures are logged
 * and never change the transaction result. The handler is invoked synchronously, so callers
 * that do not await the returned promise keep fire-and-forget behavior.
 */
export async function deliverDeadLetter(
  handler: FatalErrorHandler,
  error: FatalOperationError,
  context: FatalErrorContext
): Promise<void> {
  try {
    await handler.onDeadLetter({
      occurrenceId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      transaction: context.transaction,
      authenticatedSubject: context.auth.sub,
      errorCode: error.errorCode,
      message: error.message,
      details: error.details,
      operationIndex: error.operationIndex
    });
  } catch (failure) {
    console.error('Dead-letter handler failed:', failure);
  }
}
