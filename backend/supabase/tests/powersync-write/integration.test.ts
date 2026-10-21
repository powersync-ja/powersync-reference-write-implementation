import { assert, assertEquals, assertMatch } from '@std/assert';
import { createPostgresPersister } from '@powersync/write-core/persistence/postgres/postgres-persistence.ts';
import { asAuthenticatedUser } from '../../functions/powersync-write/rls.ts';
import { admin, applyTestSchema, batch, del, FUNCTION_URL, listRow, POOLER_URL, patch, post, postBody, put, signUp, todoRow, type TestUser } from './helpers.ts';

const id = () => crypto.randomUUID();
let a: TestUser;
let b: TestUser;

Deno.test({
  name: 'powersync-write against local Supabase',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await applyTestSchema();
    [a, b] = await Promise.all([signUp('user-a'), signUp('user-b')]);

    await t.step('applies a user’s own create, update, and delete in order', async () => {
      const list = id();
      const todo = id();
      let res = await post(a.token, batch([put('lists', list, { name: 'Groceries' }), put('todos', todo, { list_id: list, description: 'Milk' })]));
      assertEquals(res.status, 200);
      assertEquals(res.body, { results: [{ status: 'success' }] });
      assertEquals(res.headers.get('access-control-allow-origin'), '*');
      assertEquals(await listRow(list), { name: 'Groceries', owner_id: a.id });

      res = await post(a.token, batch([patch('todos', todo, { completed: 1 })], [del('lists', list)]));
      assertEquals(res.body.results, [{ status: 'success' }, { status: 'success' }]);
      assertEquals(await listRow(list), undefined);
      assertEquals(await todoRow(todo), undefined);
    });

    await t.step('rejects writes into another user’s rows through RLS', async () => {
      const list = id();
      await post(b.token, batch([put('lists', list, { name: 'B private' })]));

      // Upsert onto B's row: the conflicting row fails the UPDATE policy.
      let res = await post(a.token, batch([put('lists', list, { name: 'taken' })]));
      assertEquals(res.body.results[0].status, 'fatal_error');
      assertEquals(res.body.results[0].failed_operation.error_code, 'UNAUTHORIZED');
      assertEquals(res.body.results[0].failed_operation.operation_index, 0);

      // Insert into B's list: the new row fails WITH CHECK.
      res = await post(a.token, batch([put('todos', id(), { list_id: list, description: 'sneaky' })]));
      assertEquals(res.body.results[0].failed_operation.error_code, 'UNAUTHORIZED');

      // Claiming B as owner of a new row fails WITH CHECK.
      const forged = id();
      res = await post(a.token, batch([put('lists', forged, { name: 'forged', owner_id: b.id })]));
      assertEquals(res.body.results[0].failed_operation.error_code, 'UNAUTHORIZED');
      assertEquals(await listRow(forged), undefined);

      // PATCH and DELETE of an invisible row affect nothing and succeed.
      res = await post(a.token, batch([patch('lists', list, { name: 'renamed' })], [del('lists', list)]));
      assertEquals(res.body.results, [{ status: 'success' }, { status: 'success' }]);
      assertEquals(await listRow(list), { name: 'B private', owner_id: b.id });
    });

    await t.step('rolls back a whole transaction and reports the original operation index', async () => {
      const list = id();
      const res = await post(
        a.token,
        batch([put('lists', list, { name: 'partial' }), put('todos', id(), { list_id: list, description: 'x', completed: 5 })], [put('lists', id(), { name: 'after' })])
      );
      assertEquals(res.status, 200);
      assertEquals(res.body.results[0].status, 'fatal_error');
      assertEquals(res.body.results[0].requires_client_handling, false);
      assertEquals(res.body.results[0].failed_operation.error_code, 'CHECK_VIOLATION');
      assertEquals(res.body.results[0].failed_operation.operation_index, 1);
      assertEquals(res.body.results[1], { status: 'not_attempted' });
      assertEquals(await listRow(list), undefined);
    });

    await t.step('keeps each request’s identity under concurrency and after failures', async () => {
      const writes = Array.from({ length: 24 }, (_, i) => ({ user: i % 2 ? b : a, list: id(), fail: i % 5 === 0 }));
      const results = await Promise.all(
        writes.map(({ user, list, fail }) =>
          post(user.token, batch(fail ? [put('lists', list, { name: 'f' }), put('todos', id(), { list_id: list, description: 'x', completed: 9 })] : [put('lists', list, { name: 'ok' })]))
        )
      );
      for (const [i, { user, list, fail }] of writes.entries()) {
        assertEquals(results[i].body.results[0].status, fail ? 'fatal_error' : 'success');
        assertEquals((await listRow(list))?.owner_id, fail ? undefined : user.id);
      }
    });

    await t.step('rejects invalid requests with 400 and does not write', async () => {
      const list = id();
      for (const body of [{ transactions: [] }, { transactions: Array.from({ length: 51 }, () => ({ crud: [] })) }, batch([{ op: 'UPSERT', table: 'lists', id: list }])]) {
        const res = await post(a.token, body);
        assertEquals(res.status, 400);
        assertMatch(res.body.message, /^request\/body/);
        assertEquals(res.headers.get('access-control-allow-origin'), '*');
      }
      const malformed = await postBody(a.token, '{"transactions": [');
      assertEquals(malformed.status, 400);
      assertEquals(malformed.body, { message: 'Request body must be JSON' });
      assertEquals(await listRow(list), undefined);
    });

    await t.step('accepts 50 transactions and an empty transaction', async () => {
      const lists = Array.from({ length: 49 }, () => id());
      const res = await post(a.token, batch([], ...lists.map((list) => [put('lists', list, { name: 'bulk' })])));
      assertEquals(res.body.results.length, 50);
      assert(res.body.results.every((r: { status: string }) => r.status === 'success'));
      assertEquals((await admin.query('select count(*)::int as n from lists where id = any($1)', [lists])).rows[0].n, 49);
    });

    await t.step('rejects unsafe table and column names before writing', async () => {
      const list = id();
      const res = await post(a.token, batch([put('lists', list, { name: 'ok' }), put('auth.users', id(), { email: 'x' })]));
      assertEquals(res.body.results[0].status, 'fatal_error');
      assertEquals(res.body.results[0].failed_operation.error_code, 'INVALID_DATA');
      assertEquals(res.body.results[0].failed_operation.operation_index, 1);
      assertEquals(await listRow(list), undefined);

      const col = await post(a.token, batch([put('lists', id(), { name: 'x', 'owner id': 'y' })]));
      assertEquals(col.body.results[0].failed_operation.error_code, 'INVALID_DATA');
    });

    await t.step('serves only the data route', async () => {
      const res = await postBody(a.token, '{}', `${FUNCTION_URL}/elsewhere`);
      assertEquals(res.status, 404);
    });

    await t.step('starts every pooled transaction with a clean identity', async () => {
      const seen: unknown[] = [];
      const persister = createPostgresPersister('postgresql://postgres:postgres@127.0.0.1:54322/postgres', undefined, {
        pool: { max: 1 },
        initializeTransaction: async (client, auth) => {
          const { rows } = await client.query(`select current_user as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`);
          seen.push(rows[0]);
          await asAuthenticatedUser(client, auth);
        }
      });
      const claims = (user: TestUser) => ({ sub: user.id, claims: { sub: user.id, role: 'authenticated' } });
      try {
        await persister.updateBatch([put('lists', id(), { name: 'p1' }) as never], claims(a));
        await persister.updateBatch([put('todos', id(), { list_id: id(), description: 'x' }) as never], claims(b)).catch(() => {});
        await persister.updateBatch([put('lists', id(), { name: 'p2' }) as never], claims(b));
      } finally {
        await persister.end();
      }
      assertEquals(seen, Array(3).fill({ role: 'postgres', claims: '' }));
    });

    await t.step('applies statement_timeout inside transactions behind a transaction pooler', async () => {
      // Transaction poolers drop pg's startup parameters, so the persister must set it per transaction.
      const seen: string[] = [];
      const persister = createPostgresPersister(POOLER_URL, undefined, {
        pool: { max: 1, statement_timeout: 1234 },
        initializeTransaction: async (client, auth) => {
          seen.push((await client.query(`select current_setting('statement_timeout') as t`)).rows[0].t);
          await asAuthenticatedUser(client, auth);
        }
      });
      try {
        await persister.updateBatch([put('lists', id(), { name: 'pooled' }) as never], { sub: a.id, claims: { sub: a.id, role: 'authenticated' } });
      } finally {
        await persister.end();
      }
      assertEquals(seen, ['1234ms']);
    });

    await admin.end();
  }
});
