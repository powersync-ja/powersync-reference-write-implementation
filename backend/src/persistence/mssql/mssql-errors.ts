import { ErrorCode, FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const MSSQL_NUMBERS: Record<number, ErrorCode> = {
  515: 'NOT_NULL_VIOLATION',
  547: 'CONSTRAINT_VIOLATION',
  2601: 'UNIQUE_VIOLATION',
  2627: 'UNIQUE_VIOLATION',
  220: 'INVALID_DATA',
  245: 'INVALID_DATA',
  2628: 'INVALID_DATA',
  8114: 'INVALID_DATA',
  8115: 'INVALID_DATA',
  8152: 'INVALID_DATA',
  207: 'SCHEMA_MISMATCH',
  208: 'SCHEMA_MISMATCH',
  102: 'SCHEMA_MISMATCH'
};

// Deadlock victim and lock request timeout: transient, not a data problem.
const RETRYABLE_MSSQL_NUMBERS = new Set([1205, 1222]);

// node-mssql's ConnectionError/RequestError for a dropped/timed-out connection carries a `.code`
// (e.g. 'ETIMEOUT', 'ESOCKET', 'ECONNCLOSED') instead of a SQL `.number`.
const RETRYABLE_MSSQL_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ECONNREFUSED']);

export const classifyMSSQLError = (error: unknown): Error => {
  if (error instanceof FatalOperationError || error instanceof RetryableError) return error;
  const { number, code } = (error as { number?: number; code?: string }) ?? {};
  const message = messageOf(error);

  const named = number != null ? MSSQL_NUMBERS[number] : undefined;
  if (named) {
    return new FatalOperationError(named, message);
  }

  if (number != null && RETRYABLE_MSSQL_NUMBERS.has(number)) {
    return new RetryableError(message);
  }
  if (number == null && (code == null || RETRYABLE_MSSQL_CODES.has(code))) {
    return new RetryableError(message);
  }

  return new FatalOperationError('UNCLASSIFIED_ERROR', message);
};
