import * as z from 'zod';
import { FatalOperationError } from '../errors.js';
import type { CollectionSchema } from '../persistence/mongo/mongo-schema.js';
import type { EntryMapper } from './types.js';

/**
 * Validates and converts fields using collection schemas discovered at startup. Invalid data is
 * rejected as an INVALID_DATA fatal error naming the offending fields.
 * The default MongoDB persister rejects collections without a discovered schema before
 * calling this mapper. The empty-schema fallback leaves fields unchanged.
 */
export const createMongoMapper = (schema: Record<string, CollectionSchema>): EntryMapper => {
  return (entry) => {
    const data = entry.op_data ?? {};
    const id = (entry.id ?? data.id) as string;

    if (entry.op === 'DELETE') {
      return { table: entry.table, op: entry.op, id, data: {} };
    }

    const { id: _discardId, ...fields } = data;
    const collectionSchema = schema[entry.table];
    if (!collectionSchema) {
      return { table: entry.table, op: entry.op, id, data: fields };
    }

    // PATCH operations carry only the changed columns.
    const validator = entry.op === 'PATCH' ? collectionSchema.partial() : collectionSchema;
    const result = validator.safeParse(fields);
    if (!result.success) {
      throw new FatalOperationError(
        'INVALID_DATA',
        `Invalid data for "${entry.table}":\n${z.prettifyError(result.error)}`,
        result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
      );
    }
    return { table: entry.table, op: entry.op, id, data: result.data as Record<string, unknown> };
  };
};
