/**
 * Opt-in checks against a deployed function on a hosted project. Skipped unless these are set:
 *
 *   POWERSYNC_TEST_HOSTED_FUNCTION_URL     https://<project-ref>.supabase.co/functions/v1/powersync-write
 *   POWERSYNC_TEST_HOSTED_PUBLISHABLE_KEY  the project's publishable key
 *   POWERSYNC_TEST_HOSTED_DB_URL           a postgres connection string (direct or session pooler)
 *                                          for setup and inspection
 *   POWERSYNC_TEST_HOSTED_EMAIL            an existing confirmed test user
 *   POWERSYNC_TEST_HOSTED_PASSWORD
 *   POWERSYNC_TEST_HOSTED_BURST            optional; concurrent writes in the burst check (default 30)
 *
 * Creates a throwaway table with an ownership policy, checks a write as the signed-in user, that
 * the function's database connection uses TLS, and that a burst stays under max_connections, then
 * drops the table. To check the default SUPABASE_DB_URL connection, deploy with
 * POWERSYNC_DATABASE_URL unset (`supabase secrets unset POWERSYNC_DATABASE_URL`).
 */
import { assert, assertEquals } from '@std/assert';
import pg from 'pg';
import { batch, patch, postBody, put } from './helpers.ts';

const env = (name: string) => Deno.env.get(`POWERSYNC_TEST_HOSTED_${name}`);
const functionUrl = env('FUNCTION_URL')?.replace(/\/+$/, '');
const publishableKey = env('PUBLISHABLE_KEY');
const dbUrl = env('DB_URL');
const email = env('EMAIL');
const password = env('PASSWORD');
const burst = Number(env('BURST') ?? 30);

const TABLE = 'powersync_hosted_check';

async function signIn(): Promise<{ id: string; token: string }> {
  const response = await fetch(`${new URL(functionUrl!).origin}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey!, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Sign-in failed: ${JSON.stringify(body)}`);
  return { id: body.user.id, token: body.access_token };
}

Deno.test({
  name: 'powersync-write on a hosted project',
  ignore: !(functionUrl && publishableKey && dbUrl && email && password),
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const admin = new pg.Pool({ connectionString: dbUrl, max: 3 });
    const write = (token: string, body: unknown) => postBody(token, JSON.stringify(body), `${functionUrl}/api/data`);

    // A throwaway table with an ownership policy, so the test needs nothing from your schema.
    await admin.query(`
      create table if not exists public.${TABLE} (
        id uuid primary key,
        owner_id uuid not null default auth.uid(),
        note text
      );
      grant select, insert, update, delete on public.${TABLE} to authenticated;
      alter table public.${TABLE} enable row level security;
      drop policy if exists "Owners manage their rows" on public.${TABLE};
      create policy "Owners manage their rows" on public.${TABLE}
        for all to authenticated
        using (owner_id = (select auth.uid()))
        with check (owner_id = (select auth.uid()));
    `);

    try {
      const user = await signIn();
      const row = crypto.randomUUID();

      await t.step('writes as the signed-in user', async () => {
        const res = await write(user.token, batch([put(TABLE, row, { note: 'hosted' })]));
        assertEquals(res.body, { results: [{ status: 'success' }] }, JSON.stringify(res.body));
        const { rows } = await admin.query(`select owner_id from public.${TABLE} where id = $1`, [row]);
        assertEquals(rows[0]?.owner_id, user.id);
      });

      await t.step('connects to the database over TLS', async () => {
        // Hold the row lock so the function's write waits, then inspect its backend.
        const holder = await admin.connect();
        try {
          await holder.query('begin');
          await holder.query(`select 1 from public.${TABLE} where id = $1 for update`, [row]);
          const pending = write(user.token, batch([patch(TABLE, row, { note: 'after lock' })]));

          let backend: { ssl: boolean; version: string | null; usename: string; client_addr: string | null } | undefined;
          for (let attempt = 0; attempt < 50 && !backend; attempt++) {
            const { rows } = await admin.query(
              `select s.ssl, s.version, a.usename, a.client_addr::text
                 from pg_stat_activity a join pg_stat_ssl s using (pid)
                where a.wait_event_type = 'Lock' and a.query ilike $1 and a.pid <> pg_backend_pid()`,
              [`%${TABLE}%`]
            );
            backend = rows[0];
            if (!backend) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await holder.query('commit');
          assertEquals((await pending).body, { results: [{ status: 'success' }] });

          assert(backend, 'did not find the function backend waiting on the row lock');
          console.log('Function database connection:', backend);
          assert(backend.ssl, `function connects without TLS: ${JSON.stringify(backend)}`);
        } finally {
          holder.release();
        }
      });

      await t.step(`serves a burst of ${burst} concurrent writes without exhausting connections`, async () => {
        const max = Number((await admin.query('show max_connections')).rows[0].max_connections);
        let peak = 0;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const { rows } = await admin.query(`select count(*)::int as n from pg_stat_activity where backend_type = 'client backend'`);
            peak = Math.max(peak, rows[0].n);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })();

        const results = await Promise.all(
          Array.from({ length: burst }, () => write(user.token, batch([put(TABLE, crypto.randomUUID(), { note: 'burst' })])))
        );
        sampling = false;
        await sampler;

        console.log(`Peak client connections during burst: ${peak} of ${max}`);
        for (const res of results) assertEquals(res.body, { results: [{ status: 'success' }] }, JSON.stringify(res.body));
        assert(peak < max, `connections reached max_connections (${peak}/${max})`);
      });
    } finally {
      await admin.query(`drop table if exists public.${TABLE}`);
      await admin.end();
    }
  }
});
