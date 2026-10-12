import type { PostgresPersisterOptions } from '../../../backend/src/persistence/postgres/postgres-persistence.ts';
import type { BatchOnFatalError } from '../../../backend/src/write/processor.ts';

/** Thrown when the function's environment is incomplete. Answered with HTTP 500. */
export class FunctionConfigError extends Error {}

export interface FunctionConfig {
  databaseUrl: string;
  issuer: string;
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
 * pooler URL. POWERSYNC_JWT_ISSUER overrides the issuer derived from SUPABASE_URL, which local
 * development needs because the runtime sees an internal URL rather than the public one.
 */
export function readConfig(): FunctionConfig {
  const databaseUrl = Deno.env.get('POWERSYNC_DATABASE_URL') || Deno.env.get('SUPABASE_DB_URL');
  if (!databaseUrl) throw new FunctionConfigError('Set POWERSYNC_DATABASE_URL or SUPABASE_DB_URL.');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const issuer = Deno.env.get('POWERSYNC_JWT_ISSUER') || (supabaseUrl && `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`);
  if (!issuer) throw new FunctionConfigError('Set POWERSYNC_JWT_ISSUER or SUPABASE_URL.');

  return { databaseUrl, issuer };
}
