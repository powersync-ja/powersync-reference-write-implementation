import { describe, expect, it, vi } from 'vitest';
import { classifyPostgresError } from '../src/persistence/postgres/postgres-errors.ts';
import { FatalOperationError, RetryableError } from '../src/errors.ts';

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
    ['42501', 'UNAUTHORIZED'],
    ['42P01', 'SCHEMA_MISMATCH'],
    ['23001', 'CONSTRAINT_VIOLATION'],
    ['22003', 'INVALID_DATA']
  ])('keeps permanent failure %s fatal', (code, errorCode) => {
    expect(classifyPostgresError({ code, message: 'permanent failure' })).toMatchObject({ errorCode });
  });
  it.each(['28P01', 'XX000', 'UNKNOWN_DRIVER_ERROR'])('retries unrecognized code %s and warns', (code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classifyPostgresError({ code, message: 'unknown failure' })).toBeInstanceOf(RetryableError);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it('preserves already classified application errors', () => {
    for (const error of [new RetryableError('retry'), new FatalOperationError('CUSTOM', 'reject')]) {
      expect(classifyPostgresError(error)).toBe(error);
    }
  });
});
