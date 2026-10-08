import { FatalOperationError } from '../../errors.js';
import mysql from 'mysql2/promise';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyMySQLError } from './mysql-errors.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { EntryMapper } from '../../mapping/types.js';
import { defaultMapper } from '../../mapping/default.js';
import type { AuthContext } from '../../auth/types.js';

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``').replace(/\./g, '`.`')}\``;
}

export const createMySQLPersister = (uri: string, mapper: EntryMapper = defaultMapper): Persister => {
  console.debug('Using MySQL Persister');

  const pool = mysql.createPool(uri);

  const persister: Persister = {
    // This adapter does not use auth yet. Add application permission checks in authorize(),
    // or check existing rows within this database transaction.
    updateBatch: async (batch: CrudEntry[], _auth: AuthContext) => {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        for (const [operationIndex, op] of batch.entries()) {
          try {
            const mapped = mapper(op);
            if (mapped === null) continue;

            const table = escapeIdentifier(mapped.table);

            if (mapped.op === 'PUT') {
              const with_id = { ...mapped.data, id: mapped.id };

              const columnsEscaped = Object.keys(with_id).map(escapeIdentifier);
              const columnsJoined = columnsEscaped.join(', ');

              const updateClauses: string[] = [];

              for (const key of Object.keys(mapped.data)) {
                if (key === 'id') continue;
                updateClauses.push(`${escapeIdentifier(key)} = VALUES(${escapeIdentifier(key)})`);
              }

              const updateClause =
                updateClauses.length > 0 ? `ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}` : ``;

              const statement = `
              INSERT INTO ${table} (${columnsJoined})
              VALUES (${Object.keys(with_id)
                .map(() => '?')
                .join(', ')})
              ${updateClause}`;

              await connection.execute(statement, Object.values(with_id));
            } else if (mapped.op === 'PATCH') {
              const updateClauses: string[] = [];

              for (const key of Object.keys(mapped.data)) {
                if (key === 'id') continue;
                updateClauses.push(`${escapeIdentifier(key)} = ?`);
              }

              if (updateClauses.length === 0) continue;

              const statement = `
              UPDATE ${table}
              SET ${updateClauses.join(', ')}
              WHERE id = ?`;

              const values = [...Object.values(mapped.data), mapped.id];
              await connection.execute(statement, values);
            } else if (mapped.op === 'DELETE') {
              const statement = `DELETE FROM ${table} WHERE id = ?`;
              await connection.execute(statement, [mapped.id]);
            }
          } catch (error) {
            const classified = classifyMySQLError(error);
            if (classified instanceof FatalOperationError) classified.operationIndex = operationIndex;
            throw classified;
          }
        }
        await connection.commit();
      } catch (e) {
        await connection.rollback().catch(() => {});
        throw classifyMySQLError(e);
      } finally {
        connection.release();
      }
    }
  };
  return persister;
};
