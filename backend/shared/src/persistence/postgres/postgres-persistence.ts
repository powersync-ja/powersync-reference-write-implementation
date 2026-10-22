import { FatalOperationError } from '../../errors.ts';
import { assertNoQuoteCharacters } from '../identifiers.ts';
import PG from 'pg';
import type { AuthContext, Persister, CrudEntry } from '../../types.ts';
import { classifyPostgresError } from './postgres-errors.ts';
import type { EntryMapper } from '../../mapping/types.ts';
import { defaultMapper } from '../../mapping/default.ts';

const { Pool } = PG;

function escapeIdentifier(identifier: string): string {
  assertNoQuoteCharacters(identifier, ['"']);
  return `"${identifier.replace(/\./g, '"."')}"`;
}

export interface PostgresPersisterOptions {
  /**
   * pg pool settings, such as max, connectionTimeoutMillis (acquisition wait), and
   * statement_timeout. Unset fields keep this adapter's defaults: max 10, 10 s connect, 30 s idle,
   * 30 s statement timeout. The connection string still supplies
   * the host, credentials, database, and TLS options.
   *
   * statement_timeout is also applied transaction-locally after BEGIN. pg sends it as a
   * connection startup parameter, which transaction poolers such as Supavisor drop.
   */
  pool?: Omit<PG.PoolConfig, 'connectionString'>;
  /**
   * Runs inside each database transaction after BEGIN and before the first operation.
   * Use transaction-local settings only, because connections are reused. Defaults to
   * exposing the verified claims as request.jwt.claims.
   */
  initializeTransaction?: (client: PG.PoolClient, auth: AuthContext) => Promise<void>;
}

/**
 * Exposes the verified token claims for this transaction as request.jwt.claims, the PostgREST
 * convention that Supabase's auth.uid() and auth.jwt() also read. Policies read the subject with
 * current_setting('request.jwt.claims', true)::json->>'sub'.
 */
export const setJwtClaims = async (client: PG.PoolClient, auth: AuthContext): Promise<void> => {
  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(auth.claims)]);
};

/**
 * PowerSync clients store JSON as TEXT, so a json/jsonb value arrives as a string. Passing that to
 * json_populate_record stores a JSON string scalar instead of the object. Parses string values of
 * json/jsonb columns so they are embedded as real JSON.
 */
const parseJsonColumns = async (
  client: PG.PoolClient,
  table: string,
  data: Record<string, unknown>,
  cache: Map<string, Promise<Set<string>>>
): Promise<Record<string, unknown>> => {
  // Refuse unsafe column names before touching the database.
  Object.keys(data).forEach(escapeIdentifier);

  let columns = cache.get(table);
  if (columns === undefined) {
    columns = client
      .query<{ attname: string }>(
        `SELECT attname FROM pg_attribute
         WHERE attrelid = $1::regclass
           AND atttypid IN ('json'::regtype, 'jsonb'::regtype)
           AND attnum > 0 AND NOT attisdropped`,
        [table]
      )
      .then((result) => new Set(result.rows.map((row) => row.attname)));
    cache.set(table, columns);
  }
  const jsonColumns = await columns;
  if (jsonColumns.size === 0) return data;

  const result = { ...data };
  for (const column of jsonColumns) {
    const value = result[column];
    if (typeof value !== 'string') continue;
    try {
      result[column] = JSON.parse(value);
    } catch {
      // Not valid JSON: keep the string, which Postgres stores as a JSON string scalar.
    }
  }
  return result;
};

export const createPostgresPersister = (
  uri: string,
  mapper: EntryMapper = defaultMapper,
  options: PostgresPersisterOptions = {}
): Persister & { end(): Promise<void> } => {
  console.debug('Using Postgres Persister');

  const initializeTransaction = options.initializeTransaction ?? setJwtClaims;
  // pg parses the connection string itself: percent-encoded credentials are decoded, a missing
  // port defaults to 5432, and sslmode (e.g. ?sslmode=require) is honoured.
  const poolConfig: PG.PoolConfig = {
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    ...options.pool,
    connectionString: uri
  };
  const pool = new Pool(poolConfig);
  const statementTimeout = poolConfig.statement_timeout;

  pool.on('error', (err, client) => {
    console.error('Pool connection failure to postgres:', err, client);
  });

  const persister = {
    /** Closes the pool. Only needed where the process does not exit, such as tests. */
    end: () => pool.end(),
    updateBatch: async (batch: CrudEntry[], auth: AuthContext) => {
      let client: PG.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw classifyPostgresError(error);
      }
      // Set when rollback fails; the connection's state is unknown, so it is discarded.
      let discard: Error | undefined;
      try {
        await client.query('BEGIN');
        if (statementTimeout !== undefined) {
          await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(statementTimeout)]);
        }

        // By default this exposes the verified claims to application RLS policies; see
        // docs/auth/authorization.md.
        await initializeTransaction(client, auth);

        const jsonColumnCache = new Map<string, Promise<Set<string>>>();

        for (const [operationIndex, op] of batch.entries()) {
          try {
            const mapped = mapper(op);
            if (mapped === null) continue;

            const table = escapeIdentifier(mapped.table);

            if (mapped.op == 'PUT') {
              const payload = {
                ...(await parseJsonColumns(client, table, mapped.data, jsonColumnCache)),
                id: mapped.id
              };

              const columnsEscaped = Object.keys(payload).map(escapeIdentifier);
              const columnsJoined = columnsEscaped.join(', ');

              const updateClauses: string[] = [];

              for (const key of Object.keys(mapped.data)) {
                if (key == 'id') {
                  continue;
                }
                updateClauses.push(`${escapeIdentifier(key)} = EXCLUDED.${escapeIdentifier(key)}`);
              }

              const updateClause =
                updateClauses.length > 0 ? `DO UPDATE SET ${updateClauses.join(', ')}` : `DO NOTHING`;

              const statement = `
                WITH data_row AS (
                    SELECT (json_populate_record(null::${table}, $1::json)).*
                )
                INSERT INTO ${table} (${columnsJoined})
                SELECT ${columnsJoined} FROM data_row
                ON CONFLICT(id) ${updateClause}`;

              await client.query(statement, [JSON.stringify(payload)]);
            } else if (mapped.op == 'PATCH') {
              const payload = {
                ...(await parseJsonColumns(client, table, mapped.data, jsonColumnCache)),
                id: mapped.id
              };

              const updateClauses: string[] = [];

              for (const key of Object.keys(mapped.data)) {
                if (key == 'id') {
                  continue;
                }
                updateClauses.push(`${escapeIdentifier(key)} = data_row.${escapeIdentifier(key)}`);
              }

              if (updateClauses.length === 0) continue;

              const statement = `
                WITH data_row AS (
                    SELECT (json_populate_record(null::${table}, $1::json)).*
                )
                UPDATE ${table}
                SET ${updateClauses.join(', ')}
                FROM data_row
                WHERE ${table}.id = data_row.id`;
              await client.query(statement, [JSON.stringify(payload)]);
            } else if (mapped.op == 'DELETE') {
              const statement = `
                WITH data_row AS (
                  SELECT (json_populate_record(null::${table}, $1::json)).*
                )
                DELETE FROM ${table}
                USING data_row
                WHERE ${table}.id = data_row.id`;
              await client.query(statement, [JSON.stringify({ id: mapped.id })]);
            }
          } catch (error) {
            const classified = classifyPostgresError(error);
            if (classified instanceof FatalOperationError) classified.operationIndex = operationIndex;
            throw classified;
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw classifyPostgresError(e);
      } finally {
        client.release(discard);
      }
    }
  };
  return persister;
};
