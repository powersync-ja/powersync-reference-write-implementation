import { ErrorCode, FatalOperationError, RetryableError, messageOf, retryUnrecognized } from '../../errors.ts';

const FATAL_POSTGRES_CODES: Record<string, ErrorCode> = {
  '23502': 'NOT_NULL_VIOLATION',
  '23503': 'FOREIGN_KEY_VIOLATION',
  '23505': 'UNIQUE_VIOLATION',
  '23514': 'CHECK_VIOLATION'
};

export const classifyPostgresError = (error: unknown): Error => {
  if (error instanceof FatalOperationError || error instanceof RetryableError) return error;
  const code = (error as { code?: string })?.code ?? '';
  const message = messageOf(error);

  const fatalCode = FATAL_POSTGRES_CODES[code];
  if (fatalCode) {
    return new FatalOperationError(fatalCode, message);
  }
  if (code.startsWith('23')) {
    return new FatalOperationError('CONSTRAINT_VIOLATION', message);
  }
  if (code.startsWith('22')) {
    return new FatalOperationError('INVALID_DATA', message);
  }
  // insufficient_privilege: a missing grant or a row-level security policy rejected the write.
  if (code === '42501') {
    return new FatalOperationError('UNAUTHORIZED', message);
  }
  if (code.startsWith('42')) {
    return new FatalOperationError('SCHEMA_MISMATCH', message);
  }

  // Node transport errors carry non-SQLSTATE codes.
  const retryableNetworkCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN'
  ]);
  if (retryableNetworkCodes.has(code)) return new RetryableError(message);

  // Class 08 (connection), 40 (transaction rollback: deadlock/serialization failure), 53
  // (insufficient resources), 57/58 (admin shutdown/system error), or no SQLSTATE at all (raw
  // driver/network error, e.g. connection reset): known transient.
  if (
    code === '' ||
    code.startsWith('08') ||
    code.startsWith('40') ||
    code.startsWith('53') ||
    code.startsWith('57') ||
    code.startsWith('58')
  ) {
    return new RetryableError(message);
  }

  // Not on the fatal list: retry, and warn so the code can be reviewed.
  return retryUnrecognized('Postgres', { code }, message);
};
