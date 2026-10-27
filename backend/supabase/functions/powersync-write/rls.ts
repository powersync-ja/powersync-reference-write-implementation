import type PG from 'pg';
import { setJwtClaims } from '@powersync/write-core/persistence/postgres/postgres-persistence.ts';
import { FatalOperationError, RetryableError } from '@powersync/write-core/errors.ts';
import type { AuthContext, Persister } from '@powersync/write-core/types.ts';

/**
 * Applies Supabase RLS for the verified caller inside the current database transaction.
 * The persister's default sets request.jwt.claims, which auth.uid() and auth.jwt() read. This
 * also switches to the authenticated role, because SUPABASE_DB_URL connects as postgres, which
 * bypasses RLS. The role is fixed rather than taken from the token. Both settings are
 * transaction-local, so pooled connections are reset on commit or rollback.
 */
export async function asAuthenticatedUser(client: PG.PoolClient, auth: AuthContext): Promise<void> {
  await setJwtClaims(client, auth);
  await client.query('SET LOCAL ROLE authenticated');
}

/**
 * Reports a denied write (a missing grant or an RLS policy, classified as UNAUTHORIZED) as
 * retryable, so the client connector keeps the transaction queued instead of losing it. A policy or grant
 * can be fixed after the fact; your app decides when to give up and dead-letter the write.
 */
export function permissionErrorsRetryable(persister: Persister): Persister {
  return {
    async updateBatch(batch, auth) {
      try {
        await persister.updateBatch(batch, auth);
      } catch (e) {
        if (e instanceof FatalOperationError && e.errorCode === 'UNAUTHORIZED') throw new RetryableError(e.message);
        throw e;
      }
    }
  };
}
