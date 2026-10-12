// SPIKE: verifies required-claims auth + a pg transaction under RLS claims/role. Replaced in phase 5.
import { pipeline } from '@supabase/middleware';
import { withCors } from '@supabase/middleware/cors';
import { withRequiredClaims } from '@supabase/server/middleware/required-claims';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: Deno.env.get('SUPABASE_DB_URL')!.replace(/@supabase_db_[^:]+:/, '@db:'),
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000
});

export default {
  fetch: pipeline([withCors({}), withRequiredClaims()], async (_req, ctx) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(ctx.jwtClaims)]);
      await client.query('set local role authenticated');
      const r = await client.query(`select auth.uid() as uid, auth.jwt()->>'role' as role, current_user`);
      await client.query('COMMIT');
      const after = await client.query(`select current_user, current_setting('request.jwt.claims', true) as claims`);
      return Response.json({ inTx: r.rows[0], afterTx: after.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return Response.json({ error: String(e) }, { status: 500 });
    } finally {
      client.release();
    }
  })
};
