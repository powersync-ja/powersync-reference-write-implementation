import { ErrorCode, FatalOperationError, RetryableError, messageOf, retryUnrecognized } from '../../errors.ts';

const FATAL_MYSQL_ERRNOS: Record<number, ErrorCode> = {
  1048: 'NOT_NULL_VIOLATION',
  1062: 'UNIQUE_VIOLATION',
  1452: 'FOREIGN_KEY_VIOLATION',
  3819: 'CHECK_VIOLATION',
  1366: 'INVALID_DATA'
};

// Deadlock, lock wait timeout, too many connections, and "server/connection gone". Mysql2 reports
// these by errno, often with a generic sqlState ('HY000') that doesn't distinguish them from fatal
// errors, so they need their own allowlist rather than a sqlState-prefix check.
const RETRYABLE_MYSQL_ERRNOS = new Set([1205, 1213, 1040, 1152, 2006, 2013]);
const RETRYABLE_MYSQL_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'PROTOCOL_SEQUENCE_TIMEOUT'
]);

export const classifyMySQLError = (error: unknown): Error => {
  if (error instanceof FatalOperationError || error instanceof RetryableError) return error;
  const { errno, sqlState, code } = (error as { errno?: number; sqlState?: string; code?: string }) ?? {};
  const message = messageOf(error);

  const fatalCode = errno != null ? FATAL_MYSQL_ERRNOS[errno] : undefined;
  if (fatalCode) {
    return new FatalOperationError(fatalCode, message);
  }

  const state = sqlState ?? '';
  if (state.startsWith('23')) {
    return new FatalOperationError('CONSTRAINT_VIOLATION', message);
  }
  if (state.startsWith('22')) {
    return new FatalOperationError('INVALID_DATA', message);
  }
  if (state.startsWith('42')) {
    return new FatalOperationError('SCHEMA_MISMATCH', message);
  }

  if ((errno != null && RETRYABLE_MYSQL_ERRNOS.has(errno)) || (code != null && RETRYABLE_MYSQL_CODES.has(code))) {
    return new RetryableError(message);
  }
  if (state.startsWith('08') || state.startsWith('40') || (errno == null && code == null)) {
    return new RetryableError(message);
  }

  // Not on the fatal list: retry, and warn so the code can be reviewed.
  return retryUnrecognized('MySQL', { errno, sqlState, code }, message);
};
