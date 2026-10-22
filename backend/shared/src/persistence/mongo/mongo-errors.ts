import { ErrorCode, FatalOperationError, RetryableError, messageOf, retryUnrecognized } from '../../errors.ts';

const FATAL_MONGO_CODES: Record<number, ErrorCode> = {
  121: 'DOCUMENT_VALIDATION_FAILURE',
  11000: 'UNIQUE_VIOLATION'
};

export const classifyMongoError = (error: unknown): Error => {
  if (error instanceof FatalOperationError || error instanceof RetryableError) return error;
  const mongoError = error as { code?: number; hasErrorLabel?: (label: string) => boolean } | null | undefined;
  const message = messageOf(error);

  if (
    mongoError?.hasErrorLabel?.('TransientTransactionError') ||
    mongoError?.hasErrorLabel?.('RetryableWriteError')
  ) {
    return new RetryableError(message);
  }

  const code = mongoError?.code;
  const fatalCode = code != null ? FATAL_MONGO_CODES[code] : undefined;
  if (fatalCode) {
    return new FatalOperationError(fatalCode, message);
  }

  // No error code at all is typical of driver/network-level failures (MongoNetworkError,
  // MongoServerSelectionError) rather than a server-classified failure: treat as retryable.
  if (code == null) {
    return new RetryableError(message);
  }

  // Not on the fatal list: retry, and warn so the code can be reviewed.
  return retryUnrecognized('MongoDB', { code }, message);
};
