import type PG from 'pg';
import type { AuthContext } from '../../../backend/src/types.ts';

/**
 * Applies Supabase RLS for the verified caller inside the current database transaction.
 * auth.uid() and auth.jwt() read request.jwt.claims. The role is fixed rather than taken from
 * the token. Both settings are transaction-local, so pooled connections are reset on commit or
 * rollback.
 */
export async function asAuthenticatedUser(client: PG.PoolClient, auth: AuthContext): Promise<void> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(auth.claims)]);
  await client.query('SET LOCAL ROLE authenticated');
}
