import { FatalOperationError } from '../../errors.ts';
import PG from 'pg';
import type { Persister, CrudEntry } from '../../types.ts';
import { classifyPostgresError } from './postgres-errors.ts';
import type { EntryMapper } from '../../mapping/types.ts';
import { defaultMapper } from '../../mapping/default.ts';
import type { AuthContext } from '../../auth/types.ts';

const { Pool } = PG;

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""').replace(/\./g, '"."')}"`;
}

export interface PostgresPersisterOptions {
  /**
   * Extra pg pool settings, such as max, connectionTimeoutMillis (acquisition wait), and
   * statement_timeout. Unset fields keep pg defaults. The connection string still supplies
   * the host, credentials, database, and TLS options.
   *
   * statement_timeout is also applied transaction-locally after BEGIN. pg sends it as a
   * connection startup parameter, which transaction poolers such as Supavisor drop.
   */
  pool?: Omit<PG.PoolConfig, 'connectionString'>;
  /**
   * Runs inside each database transaction after BEGIN and before the first operation.
   * Use transaction-local settings only, because connections are reused. Defaults to
   * exposing the verified subject as app.user_id.
   */
  initializeTransaction?: (client: PG.PoolClient, auth: AuthContext) => Promise<void>;
}

/** Exposes the verified subject for this transaction as current_setting('app.user_id', true). */
export const setAppUserId = async (client: PG.PoolClient, auth: AuthContext): Promise<void> => {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', auth.sub]);
};

export const createPostgresPersister = (
  uri: string,
  mapper: EntryMapper = defaultMapper,
  options: PostgresPersisterOptions = {}
): Persister & { end(): Promise<void> } => {
  console.debug('Using Postgres Persister');

  const initializeTransaction = options.initializeTransaction ?? setAppUserId;
  const pool = new Pool({ ...options.pool, connectionString: uri });
  const statementTimeout = options.pool?.statement_timeout;

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

        // By default this exposes the verified subject to application RLS policies; see
        // docs/authorization.md.
        await initializeTransaction(client, auth);

        for (const [operationIndex, op] of batch.entries()) {
          try {
            const mapped = mapper(op);
            if (mapped === null) continue;

            const table = escapeIdentifier(mapped.table);

            if (mapped.op == 'PUT') {
              const with_id = { ...mapped.data, id: mapped.id };

              const columnsEscaped = Object.keys(with_id).map(escapeIdentifier);
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

              await client.query(statement, [JSON.stringify(with_id)]);
            } else if (mapped.op == 'PATCH') {
              const with_id = { ...mapped.data, id: mapped.id };

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
              await client.query(statement, [JSON.stringify(with_id)]);
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
