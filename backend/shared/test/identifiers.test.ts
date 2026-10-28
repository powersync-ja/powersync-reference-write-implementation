import { describe, expect, it } from 'vitest';
import { FatalOperationError } from '../src/errors.ts';
import { assertSafeIdentifier, assertSafeTransaction, MAX_IDENTIFIER_LENGTH } from '../src/persistence/identifiers.ts';

describe('assertSafeIdentifier', () => {
  it.each(['todos', 'Todo_Items', '_private', 'a1', 'a'.repeat(MAX_IDENTIFIER_LENGTH)])('accepts %s', (name) => {
    expect(() => assertSafeIdentifier(name, 'table')).not.toThrow();
  });

  it.each([
    '',
    '1abc',
    'a b',
    'a-b',
    'a.b',
    'a"b',
    'a`b',
    'a]b',
    'a;b',
    "a'b",
    'a--b',
    '$where',
    'ünï',
    'a\n',
    'a'.repeat(MAX_IDENTIFIER_LENGTH + 1)
  ])('rejects %j', (name) => {
    expect(() => assertSafeIdentifier(name, 'column')).toThrow(FatalOperationError);
  });

  it('rejects non-strings', () => {
    expect(() => assertSafeIdentifier(42, 'table')).toThrow(FatalOperationError);
    expect(() => assertSafeIdentifier(undefined, 'table')).toThrow(FatalOperationError);
  });

  it('reports INVALID_DATA with the kind, and truncates long names in the message', () => {
    const error = (() => {
      try {
        assertSafeIdentifier('x'.repeat(500) + ';', 'table');
      } catch (e) {
        return e as FatalOperationError;
      }
    })();
    expect(error).toMatchObject({ errorCode: 'INVALID_DATA', details: { identifier_kind: 'table' } });
    expect(error!.message.length).toBeLessThan(250);
  });
});

describe('assertSafeTransaction', () => {
  it('checks the table and every op_data key of every operation', () => {
    expect(() => assertSafeTransaction([{ op: 'PUT', id: '1', table: 't', op_data: { a: 1, b: 2 } }])).not.toThrow();
    expect(() => assertSafeTransaction([{ op: 'DELETE', id: '1', table: 't' }])).not.toThrow();
    expect(() => assertSafeTransaction([{ op: 'PUT', id: '1', table: 't', op_data: { a: 1, 'b c': 2 } }])).toThrow(
      FatalOperationError
    );
  });

  it('reports the index of the first offending operation', () => {
    const error = (() => {
      try {
        assertSafeTransaction([
          { op: 'DELETE', id: '1', table: 'ok' },
          { op: 'DELETE', id: '2', table: 'bad.table' },
          { op: 'DELETE', id: '3', table: 'also;bad' }
        ]);
      } catch (e) {
        return e as FatalOperationError;
      }
    })();
    expect(error).toMatchObject({ errorCode: 'INVALID_DATA', operationIndex: 1 });
  });

  it('does not validate values or the row id', () => {
    expect(() =>
      assertSafeTransaction([{ op: 'PUT', id: "x'; --", table: 't', op_data: { a: "'; DROP" } }])
    ).not.toThrow();
  });
});
