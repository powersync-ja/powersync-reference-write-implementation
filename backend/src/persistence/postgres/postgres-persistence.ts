import { FatalOperationError } from '../../errors.js';
import { URL } from 'url';
import PG from 'pg';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyPostgresError } from './postgres-errors.js';
import type { EntryMapper } from '../../mapping/types.js';
import { defaultMapper } from '../../mapping/default.js';
import type { AuthContext } from '../../auth/types.js';

const { Pool } = PG;

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""').replace(/\./g, '"."')}"`;
}

export const createPostgresPersister = (uri: string, mapper: EntryMapper = defaultMapper): Persister => {
  console.debug('Using Postgres Persister');

  const url = new URL(uri);

  const pool = new Pool({
    host: url.hostname,
    database: url.pathname.split('/')[1],
    user: url.username,
    password: url.password,
    port: parseInt(url.port)
  });

  pool.on('error', (err, client) => {
    console.error('Pool connection failure to postgres:', err, client);
  });

  const persister: Persister = {
    updateBatch: async (batch: CrudEntry[], auth: AuthContext) => {
      let client: PG.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw classifyPostgresError(error);
      }
      try {
        await client.query('BEGIN');

        // Expose the verified subject for this transaction. Application RLS policies can read
        // current_setting('app.user_id', true). Define policies for your tables as described
        // in docs/authorization.md.
        await client.query('SELECT set_config($1, $2, true)', ['app.user_id', auth.sub]);

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
        await client.query('ROLLBACK').catch(() => {});
        throw classifyPostgresError(e);
      } finally {
        client.release();
      }
    }
  };
  return persister;
};
