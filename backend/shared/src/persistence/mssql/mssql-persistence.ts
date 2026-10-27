import { FatalOperationError, connectionFailure } from '../../errors.ts';
import { assertNoQuoteCharacters } from '../identifiers.ts';
import { URL } from 'url';
import sql from 'mssql';
import type { AuthContext, Persister, CrudEntry } from '../../types.ts';
import { classifyMSSQLError } from './mssql-errors.ts';
import type { EntryMapper } from '../../mapping/types.ts';
import { defaultMapper } from '../../mapping/default.ts';

function escapeIdentifier(identifier: string): string {
  assertNoQuoteCharacters(identifier, ['[', ']']);
  return `[${identifier}]`;
}

function booleanParam(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const value = params.get(name);
  if (value === null) return fallback;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid value for MSSQL URI parameter ${name}: ${value}`);
}

/**
 * Parses mssql://user:pass@host[:port]/database[?encrypt=true&trustServerCertificate=false].
 * Credentials are percent-decoded. Certificates are verified unless trustServerCertificate=true
 * is set explicitly (e.g. for local development with a self-signed certificate).
 */
export function parseMSSQLUri(uri: string): sql.config {
  const url = new URL(uri);
  const database = decodeURIComponent(url.pathname.split('/')[1] ?? '');
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    server: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 1433,
    database: database || undefined,
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: booleanParam(url.searchParams, 'encrypt', true),
      trustServerCertificate: booleanParam(url.searchParams, 'trustServerCertificate', false)
    }
  };
}

export const createMSSQLPersister = async (uri: string, mapper: EntryMapper = defaultMapper): Promise<Persister> => {
  console.debug('Using MSSQL Persister');

  const pool = new sql.ConnectionPool(parseMSSQLUri(uri));

  pool.on('error', (err: Error) => {
    console.error('MSSQL pool connection failure', err);
  });

  await pool.connect();

  const persister: Persister = {
    ping: async () => {
      await pool.request().query('SELECT 1');
    },
    // This adapter does not use auth yet. Add application permission checks in authorize(),
    // or check existing rows within this database transaction.
    updateBatch: async (batch: CrudEntry[], _auth: AuthContext) => {
      const transaction = pool.transaction();
      try {
        await transaction.begin();
      } catch (error) {
        throw connectionFailure(error);
      }
      try {
        for (const [operationIndex, op] of batch.entries()) {
          try {
            const mapped = mapper(op);
            if (mapped === null) continue;

            const table = escapeIdentifier(mapped.table);

            if (mapped.op == 'PUT') {
              const with_id: Record<string, unknown> = { ...mapped.data, id: mapped.id };

              // Parameters are positional: column names are never part of a parameter name.
              const columnNames = Object.keys(with_id);
              const columnsEscaped = columnNames.map(escapeIdentifier);
              const columns = columnsEscaped.join(', ');
              const columnParamaters = columnNames.map((_, i) => `@p${i}`).join(', ');
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
            MERGE INTO ${table} WITH (HOLDLOCK) AS t
            USING (VALUES (${columnParamaters})) AS source (${columns})
              ON t.[id] = source.[id]
            ${updateClause ? updateClause : ''}
            ${insertClause};
            `;

              const request = transaction.request();
              columnNames.forEach((column, i) => request.input(`p${i}`, with_id[column]));
              await request.query(statement);
            } else if (mapped.op == 'PATCH') {
              const fields = Object.entries(mapped.data).filter(([key]) => key != 'id');
              if (fields.length === 0) continue;

              const updateClauses = fields.map(([key], i) => `${escapeIdentifier(key)} = @p${i}`);

              const statement = `
              UPDATE ${table}
              SET ${updateClauses.join(', ')}
              WHERE id = @id`;

              const request = transaction.request();
              fields.forEach(([, value], i) => request.input(`p${i}`, value));
              request.input('id', mapped.id);

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
