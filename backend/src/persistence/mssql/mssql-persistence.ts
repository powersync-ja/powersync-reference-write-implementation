import { FatalOperationError } from '../../errors.js';
import { URL } from 'url';
import sql from 'mssql';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyMSSQLError } from './mssql-errors.js';
import type { EntryMapper } from '../../mapping/types.js';
import { defaultMapper } from '../../mapping/default.js';
import type { AuthContext } from '../../auth/types.js';

function escapeIdentifier(identifier: string): string {
  return `[${identifier}]`;
}

export const createMSSQLPersister = async (uri: string, mapper: EntryMapper = defaultMapper): Promise<Persister> => {
  console.debug('Using MSSQL Persister');

  const url = new URL(uri);

  const pool = new sql.ConnectionPool({
    user: url.username,
    password: url.password,
    server: url.hostname,
    port: parseInt(url.port),
    database: url.pathname.split('/')[1],
    options: {
      encrypt: true,
      trustServerCertificate: true
    }
  });

  pool.on('error', (err: Error) => {
    console.error('MSSQL pool connection failure', err);
  });

  await pool.connect();

  const persister: Persister = {
    // This adapter does not use auth yet. Add application permission checks in authorize(),
    // or check existing rows within this database transaction.
    updateBatch: async (batch: CrudEntry[], _auth: AuthContext) => {
      const transaction = pool.transaction();
      try {
        await transaction.begin();

        for (const [operationIndex, op] of batch.entries()) {
          try {
            const mapped = mapper(op);
            if (mapped === null) continue;

            const table = escapeIdentifier(mapped.table);

            if (mapped.op == 'PUT') {
              const with_id: Record<string, unknown> = { ...mapped.data, id: mapped.id };

              const columnNames = Object.keys(with_id);
              const columnsEscaped = columnNames.map(escapeIdentifier);
              const columns = columnsEscaped.join(', ');
              const columnParamaters = columnNames.map((c) => `@${c}`).join(', ');
              const sourceColumns = columnsEscaped.map((column) => `source.${column}`).join(', ');

              const updateClauses: string[] = [];
              for (const key of Object.keys(mapped.data)) {
                if (key == 'id') {
                  continue;
                }
                updateClauses.push(`${escapeIdentifier(key)} = source.${escapeIdentifier(key)}`);
              }

              const updateClause =
                updateClauses.length > 0 ? `WHEN MATCHED THEN UPDATE SET ${updateClauses.join(', ')}` : null;
              const insertClause = `WHEN NOT MATCHED THEN INSERT (${columns}) VALUES (${sourceColumns})`;

              const statement = `
            MERGE INTO ${table} AS t
            USING (VALUES (${columnParamaters})) AS source (${columns})
              ON t.[id] = source.[id]
            ${updateClause ? updateClause : ''}
            ${insertClause};
            `;

              const request = transaction.request();
              for (const column of columnNames) {
                request.input(column, with_id[column]);
              }
              await request.query(statement);
            } else if (mapped.op == 'PATCH') {
              const with_id: Record<string, unknown> = { ...mapped.data, id: mapped.id };

              const updateClauses: string[] = [];

              for (const key of Object.keys(mapped.data)) {
                if (key == 'id') {
                  continue;
                }
                updateClauses.push(`${escapeIdentifier(key)} = @${key}`);
              }

              if (updateClauses.length === 0) continue;

              const statement = `
              UPDATE ${table}
              SET ${updateClauses.join(', ')}
              WHERE id = @id`;

              const request = transaction.request();
              for (const column of Object.keys(with_id)) {
                request.input(column, with_id[column]);
              }

              await request.query(statement);
            } else if (mapped.op == 'DELETE') {
              const statement = `DELETE FROM ${table} WHERE id = @id`;
              const request = transaction.request();
              request.input('id', mapped.id);
              await request.query(statement);
            }
          } catch (error) {
            const classified = classifyMSSQLError(error);
            if (classified instanceof FatalOperationError) classified.operationIndex = operationIndex;
            throw classified;
          }
        }
        await transaction.commit();
      } catch (e) {
        await transaction.rollback().catch(() => {});
        throw classifyMSSQLError(e);
      }
    }
  };
  return persister;
};
