import { ErrorCode, FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const POSTGRES_CODES: Record<string, ErrorCode> = {
  '23502': 'NOT_NULL_VIOLATION',
  '23503': 'FOREIGN_KEY_VIOLATION',
  '23505': 'UNIQUE_VIOLATION',
  '23514': 'CHECK_VIOLATION'
};

export const classifyPostgresError = (error: unknown): Error => {
  if (error instanceof FatalOperationError || error instanceof RetryableError) return error;
  const code = (error as { code?: string })?.code ?? '';
  const message = messageOf(error);

  const named = POSTGRES_CODES[code];
  if (named) {
    return new FatalOperationError(named, message);
  }
  if (code.startsWith('23')) {
    return new FatalOperationError('CONSTRAINT_VIOLATION', message);
  }
  if (code.startsWith('22')) {
    return new FatalOperationError('INVALID_DATA', message);
  }
  if (code.startsWith('42')) {
    return new FatalOperationError('SCHEMA_MISMATCH', message);
  }

  // Node transport errors carry non-SQLSTATE codes. Retry only known transient codes;
  // unknown driver errors still follow the existing fatal classification below.
  const networkCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN'
  ]);
  if (networkCodes.has(code)) return new RetryableError(message);

  // Class 08 (connection), 40 (transaction rollback: deadlock/serialization failure), 53
  // (insufficient resources), 57/58 (admin shutdown/system error), or no SQLSTATE at all (raw
  // driver/network error, e.g. connection reset): known-transient buckets, kept retryable.
  // Everything else unrecognized is treated as fatal below rather than retried forever.
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

  return new FatalOperationError('UNCLASSIFIED_ERROR', message);
};
