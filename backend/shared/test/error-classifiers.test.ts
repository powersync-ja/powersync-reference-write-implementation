import { describe, expect, it, vi } from 'vitest';
import { classifyMongoError } from '../src/persistence/mongo/mongo-errors.ts';
import { classifyMSSQLError } from '../src/persistence/mssql/mssql-errors.ts';
import { classifyMySQLError } from '../src/persistence/mysql/mysql-errors.ts';
import { FatalOperationError, RetryableError } from '../src/errors.ts';

describe('unrecognized errors are retryable', () => {
  it.each([
    ['mysql', classifyMySQLError, { errno: 9999, sqlState: 'HY000', code: 'ER_SOMETHING_NEW' }],
    ['mssql', classifyMSSQLError, { number: 99999 }],
    ['mongo', classifyMongoError, { code: 99999 }]
  ])('%s', (_name, classify, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classify({ ...error, message: 'unknown' })).toBeInstanceOf(RetryableError);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('named fatal codes stay fatal', () => {
  it.each([
    ['mysql', classifyMySQLError, { errno: 1062 }, 'UNIQUE_VIOLATION'],
    ['mysql', classifyMySQLError, { errno: 1, sqlState: '42S02' }, 'SCHEMA_MISMATCH'],
    ['mssql', classifyMSSQLError, { number: 2627 }, 'UNIQUE_VIOLATION'],
    ['mssql', classifyMSSQLError, { number: 208 }, 'SCHEMA_MISMATCH'],
    ['mongo', classifyMongoError, { code: 11000 }, 'UNIQUE_VIOLATION'],
    ['mongo', classifyMongoError, { code: 121 }, 'DOCUMENT_VALIDATION_FAILURE']
  ])('%s %j', (_name, classify, error, errorCode) => {
    const result = classify({ ...error, message: 'permanent' });
    expect(result).toBeInstanceOf(FatalOperationError);
    expect(result).toMatchObject({ errorCode });
  });
});
