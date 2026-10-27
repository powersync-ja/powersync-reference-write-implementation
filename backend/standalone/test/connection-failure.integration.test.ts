import { afterEach, describe, expect, it } from 'vitest';
import { RetryableError } from '../../shared/src/errors.ts';
import { factories } from '../src/persistence/persister-factories.ts';
import type { Persister } from '../../shared/src/types.ts';

/**
 * Checks how each database type handles a connection that cannot be established. Point it at
 * a database that will refuse the connection (a closed port, a wrong password, an unknown
 * database) and it asserts the failure is surfaced and retryable rather than dropping writes.
 * Skipped unless both variables are set, e.g.
 *
 *   CONNECTION_TEST_DB_TYPE=postgres \
 *   CONNECTION_TEST_URI='postgres://user:wrong-password@localhost:5432/postgres' \
 *   pnpm test connection-failure
 *
 * DB type is one of the keys in persister-factories.ts: mongodb, postgres, mysql, mssql.
 */
const type = process.env.CONNECTION_TEST_DB_TYPE;
const uri = process.env.CONNECTION_TEST_URI;

const auth = { sub: 'user-1', claims: { sub: 'user-1' } };
const batch = [{ op: 'DELETE' as const, table: 'items', id: '1' }];

describe.skipIf(!type || !uri)(`${type} persister with a connection that fails`, () => {
  let persister: (Persister & { end?: () => Promise<void> }) | undefined;

  afterEach(async () => {
    await persister?.end?.();
    persister = undefined;
  });

  it('is a supported database type', () => {
    expect(Object.keys(factories)).toContain(type);
  });

  // Mongo and MSSQL connect when created, so a bad connection stops startup. Postgres and MySQL
  // connect lazily, so the failure has to surface from ping() and from writes instead.
  it('fails at startup, or fails ping() and writes with a retryable error', async () => {
    try {
      persister = await factories[type!](uri!);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toBe('');
      return;
    }

    await expect(persister.ping()).rejects.toThrow();
    await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
  });
});
