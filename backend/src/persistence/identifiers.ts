import { FatalOperationError } from '../errors.ts';
import type { CrudEntry } from '../types.ts';

// Letters, digits and underscores, not starting with a digit. Deliberately excludes dots (schema
// traversal), quotes, brackets, whitespace and `$` (MongoDB operators).
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Postgres' limit (NAMEDATALEN - 1) is the strictest of the supported databases.
export const MAX_IDENTIFIER_LENGTH = 63;

const preview = (name: string): string => JSON.stringify(name.length > 40 ? `${name.slice(0, 40)}...` : name);

/**
 * Rejects a client-supplied table, collection or column name unless it is a plain identifier.
 * The adapters also escape identifiers, but they interpolate them into SQL text, so this allowlist
 * is the first line of defence and keeps hostile names out of error messages and logs.
 */
export function assertSafeIdentifier(name: unknown, kind: 'table' | 'column'): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER.test(name)
  ) {
    throw new FatalOperationError(
      'INVALID_DATA',
      `Invalid ${kind} name${typeof name === 'string' ? ` ${preview(name)}` : ''}: use only letters, digits and ` +
        `underscores, starting with a letter or underscore, at most ${MAX_IDENTIFIER_LENGTH} characters.`,
      { identifier_kind: kind }
    );
  }
}

/**
 * Refuses an identifier that contains one of the database's quoting characters, instead of
 * escaping it. The transaction processor validates client names before a persister runs, so
 * these characters can only come from a custom mapper.
 */
export function assertNoQuoteCharacters(identifier: string, quoteCharacters: string[]): void {
  if (quoteCharacters.some((quote) => identifier.includes(quote))) {
    throw new FatalOperationError(
      'INVALID_DATA',
      `Identifier ${preview(identifier)} contains a quote character (${quoteCharacters.join(' ')}).`
    );
  }
}

/**
 * Validates every identifier the client controls in an uploaded transaction: each operation's table
 * and `op_data` keys. The persister factories run it before any persister starts work, so no
 * adapter or mapper sees an unvalidated client name. Names a custom mapper emits are its own
 * responsibility and are still escaped by each adapter.
 *
 * Throws a FatalOperationError carrying the index of the first offending operation.
 */
export function assertSafeTransaction(crud: CrudEntry[]): void {
  for (const [operationIndex, entry] of crud.entries()) {
    try {
      assertSafeIdentifier(entry.table, 'table');
      if (entry.op_data) {
        for (const key of Object.keys(entry.op_data)) assertSafeIdentifier(key, 'column');
      }
    } catch (error) {
      if (error instanceof FatalOperationError) error.operationIndex = operationIndex;
      throw error;
    }
  }
}
