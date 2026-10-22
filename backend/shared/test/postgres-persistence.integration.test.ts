import { randomUUID } from 'node:crypto';
import PG from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPersister } from '../src/persistence/postgres/postgres-persistence.ts';
import type { AuthContext, CrudEntry } from '../src/types.ts';

/**
 * Needs a real Postgres; json_populate_record's jsonb handling cannot be reproduced with mocks.
 * Skipped unless POSTGRES_TEST_URL is set, e.g.
 *
 *   docker run -d --name postgres-test -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
 *   POSTGRES_TEST_URL='postgresql://postgres:test@localhost:5432/postgres' pnpm test postgres-persistence
 */
const url = process.env.POSTGRES_TEST_URL;
const table = `json_docs_${process.pid}`;
const auth: AuthContext = { sub: 'user-1', claims: { sub: 'user-1' } };
const put = (id: string, op_data: Record<string, unknown>): CrudEntry => ({ op: 'PUT', table, id, op_data });
const patch = (id: string, op_data: Record<string, unknown>): CrudEntry => ({ op: 'PATCH', table, id, op_data });

describe.skipIf(!url)('postgres persister against a real database', () => {
  let admin: PG.Client;
  let persister: ReturnType<typeof createPostgresPersister>;

  beforeAll(async () => {
    admin = new PG.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS "${table}"`);
    await admin.query(`
      CREATE TABLE "${table}" (
        id uuid PRIMARY KEY,
        title text,
        meta jsonb,
        raw json,
        count integer
      )`);
    persister = createPostgresPersister(url!, (entry) => ({
      table: entry.table,
      op: entry.op,
      id: entry.id,
      data: entry.op === 'DELETE' ? {} : (entry.op_data ?? {})
    }));
  });

  afterAll(async () => {
    await persister?.end();
    await admin?.query(`DROP TABLE IF EXISTS "${table}"`);
    await admin?.end();
  });

  const row = async (id: string) =>
    (
      await admin.query(
        `SELECT title, meta, raw, count, jsonb_typeof(meta) AS meta_type FROM "${table}" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  it('stores TEXT-encoded JSON as an object in jsonb and json columns', async () => {
    const id = randomUUID();
    await persister.updateBatch(
      [put(id, { title: 'a', meta: JSON.stringify({ tags: ['x'], n: 1 }), raw: '{"k":"v"}', count: 3 })],
      auth
    );
    expect(await row(id)).toMatchObject({
      title: 'a',
      meta: { tags: ['x'], n: 1 },
      meta_type: 'object',
      raw: { k: 'v' },
      count: 3
    });
  });

  it('parses JSON arrays and keeps null', async () => {
    const id = randomUUID();
    await persister.updateBatch([put(id, { meta: '[1,2]', raw: null })], auth);
    expect(await row(id)).toMatchObject({ meta: [1, 2], meta_type: 'array', raw: null });
  });

  it('parses JSON on PATCH and on upsert', async () => {
    const id = randomUUID();
    await persister.updateBatch([put(id, { title: 'a', meta: '{"v":1}' })], auth);
    await persister.updateBatch([patch(id, { meta: '{"v":2}' })], auth);
    expect(await row(id)).toMatchObject({ title: 'a', meta: { v: 2 }, meta_type: 'object' });

    await persister.updateBatch([put(id, { title: 'b', meta: '{"v":3}' })], auth);
    expect(await row(id)).toMatchObject({ title: 'b', meta: { v: 3 }, meta_type: 'object' });
  });

  it('leaves non-JSON strings as a JSON string scalar', async () => {
    const id = randomUUID();
    await persister.updateBatch([put(id, { meta: 'not json' })], auth);
    expect(await row(id)).toMatchObject({ meta: 'not json', meta_type: 'string' });
  });

  it('does not touch text columns that hold JSON-looking strings', async () => {
    const id = randomUUID();
    await persister.updateBatch([put(id, { title: '{"a":1}' })], auth);
    expect((await row(id)).title).toBe('{"a":1}');
  });

  it('deletes rows', async () => {
    const id = randomUUID();
    await persister.updateBatch([put(id, { title: 'gone' })], auth);
    await persister.updateBatch([{ op: 'DELETE', table, id }], auth);
    expect(await row(id)).toBeUndefined();
  });
});
