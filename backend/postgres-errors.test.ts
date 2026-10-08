import { describe, expect, it } from 'vitest';
import { classifyPostgresError } from './src/persistence/postgres/postgres-errors.js';
import { FatalOperationError, RetryableError } from './src/errors.js';

describe('Postgres error classification', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ENOTFOUND',
    'EAI_AGAIN',
    '08006',
    '40001',
    '57P01'
  ])('retries %s', (code) => {
    expect(classifyPostgresError({ code, message: 'transient failure' })).toBeInstanceOf(RetryableError);
  });
  it.each([
    ['23502', 'NOT_NULL_VIOLATION'],
    ['23505', 'UNIQUE_VIOLATION'],
    ['42501', 'SCHEMA_MISMATCH'],
    ['28P01', 'UNCLASSIFIED_ERROR'],
    ['UNKNOWN_DRIVER_ERROR', 'UNCLASSIFIED_ERROR']
  ])('keeps permanent failure %s fatal', (code, errorCode) => {
    expect(classifyPostgresError({ code, message: 'permanent failure' })).toMatchObject({ errorCode });
  });
  it('preserves already classified application errors', () => {
    for (const error of [new RetryableError('retry'), new FatalOperationError('CUSTOM', 'reject')]) {
      expect(classifyPostgresError(error)).toBe(error);
    }
  });
});
