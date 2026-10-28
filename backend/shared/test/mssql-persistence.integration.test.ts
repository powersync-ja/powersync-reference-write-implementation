import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import { createMSSQLPersister, parseMSSQLUri } from '../src/persistence/mssql/mssql-persistence.ts';
import type { CrudEntry, Persister } from '../src/types.ts';
import type { EntryMapper } from '../src/mapping/types.ts';

/**
 * Needs a real SQL Server; the insertion race cannot be reproduced with mocks. Skipped unless
 * MSSQL_TEST_URL is set, e.g.
 *
 *   docker run -d --name mssql-test -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Passw0rd!Test' \
 *     -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
 *   MSSQL_TEST_URL='mssql://sa:Passw0rd!Test@localhost:1433/master?trustServerCertificate=true' pnpm test mssql-persistence
 */
const url = process.env.MSSQL_TEST_URL;
const table = `race_items_${process.pid}`;
const auth = { sub: 'test', claims: {} };

// The default mapper logs on every call; with hundreds of concurrent writes that is just noise.
const mapper: EntryMapper = (entry) => {
  const { id: _id, ...fields } = entry.op_data ?? {};
  return { table: entry.table, op: entry.op, id: entry.id as string, data: fields };
};

const put = (id: string, value: number): CrudEntry => ({
  op: 'PUT',
  table,
  id,
  op_data: { value }
});

describe.skipIf(!url)('MSSQL persister concurrency', () => {
  let admin: sql.ConnectionPool;
  let persister: Persister;

  beforeAll(async () => {
    admin = await new sql.ConnectionPool(parseMSSQLUri(url!)).connect();
    await admin.query(`CREATE TABLE [${table}] ([id] NVARCHAR(64) NOT NULL PRIMARY KEY, [value] INT NOT NULL)`);
    persister = await createMSSQLPersister(url!, mapper);
  });

  afterAll(async () => {
    await admin?.query(`DROP TABLE IF EXISTS [${table}]`);
    await admin?.close();
  });

  const countRows = async (id: string) => {
    const result = await admin.request().input('id', id).query(`SELECT COUNT(*) AS n FROM [${table}] WHERE id = @id`);
    return result.recordset[0].n as number;
  };

  it('concurrent PUTs for the same id insert exactly one row', async () => {
    // The race is timing dependent, so repeat over fresh ids.
    for (let round = 0; round < 10; round++) {
      const id = `same-${round}`;
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => persister.updateBatch([put(id, i)], auth))
      );

      const failures = results.filter((r) => r.status === 'rejected');
      expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
      expect(await countRows(id)).toBe(1);
    }
  });

  it('concurrent PUTs for distinct ids all succeed (no deadlocks)', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `distinct-${i}`);
    const results = await Promise.allSettled(ids.map((id, i) => persister.updateBatch([put(id, i)], auth)));

    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

    const total = await admin.query(`SELECT COUNT(*) AS n FROM [${table}] WHERE id LIKE 'distinct-%'`);
    expect(total.recordset[0].n).toBe(ids.length);
  });
});
