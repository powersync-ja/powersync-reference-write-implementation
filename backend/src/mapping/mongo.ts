import { applySchema } from '../persistence/mongo/mongo-schema.js';
import type { TableSchema } from '../persistence/mongo/mongo-schema.js';
import type { EntryMapper } from './types.js';

/**
 * Converts fields using collection schemas discovered at startup.
 * The default MongoDB persister rejects collections without a discovered schema before
 * calling this mapper. The empty-schema fallback leaves fields unchanged.
 */
export const createMongoMapper = (schema: Record<string, TableSchema>): EntryMapper => {
  return (entry) => {
    const data = entry.op_data ?? {};
    const id = (entry.id ?? data.id) as string;

    if (entry.op === 'DELETE') {
      return { table: entry.table, op: entry.op, id, data: {} };
    }

    const { id: _discardId, ...fields } = data;
    const converted = applySchema(schema[entry.table] ?? {}, fields);
    return { table: entry.table, op: entry.op, id, data: converted };
  };
};
