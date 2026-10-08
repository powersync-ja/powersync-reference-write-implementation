/**
 * The backend cannot start because of invalid configuration.
 * The message should explain how to fix it.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Transient failure (deadlock, timeout, connection error). Client should retry. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type ErrorCode =
  | 'NOT_NULL_VIOLATION'
  | 'UNIQUE_VIOLATION'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_DATA'
  | 'SCHEMA_MISMATCH'
  | 'DOCUMENT_VALIDATION_FAILURE'
  | 'UNAUTHORIZED'
  | 'UNCLASSIFIED_ERROR'
  | (string & {});

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Permanent rejection; the shared handler decides who must handle it. */
export class FatalOperationError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly details?: JsonValue,
    public operationIndex?: number
  ) {
    super(message);
  }
}

export const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : String(error);
};
