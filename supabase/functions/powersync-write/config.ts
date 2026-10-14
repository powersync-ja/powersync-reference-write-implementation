import type { PostgresPersisterOptions } from '../../../backend/src/persistence/postgres/postgres-persistence.ts';
import type { BatchOnFatalError } from '../../../backend/src/write/processor.ts';

/** Thrown when the function's environment is incomplete. Answered with HTTP 500. */
export class FunctionConfigError extends Error {}

export interface FunctionConfig {
  databaseUrl: string;
}

/**
 * Pool limits for one function worker. Each worker has its own pool, so keep max small and
 * connect through the Supabase transaction pooler in hosted projects.
 */
export const pool: PostgresPersisterOptions['pool'] = {
  max: 3,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
  statement_timeout: 10_000
};

/** stop (default) or skip; see docs/error-handling.md. */
export const batchOnFatalError: BatchOnFatalError = 'stop';

/**
 * POWERSYNC_DATABASE_URL overrides the injected SUPABASE_DB_URL, for example with the transaction
 * pooler URL.
 */
export function readConfig(): FunctionConfig {
  const databaseUrl = Deno.env.get('POWERSYNC_DATABASE_URL') || Deno.env.get('SUPABASE_DB_URL');
  if (!databaseUrl) throw new FunctionConfigError('Set POWERSYNC_DATABASE_URL or SUPABASE_DB_URL.');

  return { databaseUrl };
}
