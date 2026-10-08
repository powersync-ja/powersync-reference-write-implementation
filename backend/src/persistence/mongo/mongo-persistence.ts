import * as mongo from 'mongodb';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyMongoError } from './mongo-errors.js';
import type { EntryMapper } from '../../mapping/types.js';
import { createMongoMapper } from '../../mapping/mongo.js';
import { discoverSchema, type TableSchema } from './mongo-schema.js';
import { FatalOperationError, RetryableError } from '../../errors.js';
import type { AuthContext } from '../../auth/types.js';

export const createMongoPersister = async (uri: string, mapper?: EntryMapper): Promise<Persister> => {
  console.debug('Using MongoDB Persister');

  const client = new mongo.MongoClient(uri);
  const db = client.db();
  await client.connect();

  // Custom mappers handle their own schema mapping; only the default mapper needs discovery.
  const schema: Record<string, TableSchema> | null = mapper ? null : await discoverSchema(db);
  const resolvedMapper = mapper ?? createMongoMapper(schema!);

  const persister: Persister = {
    // This adapter does not use auth yet. Add application permission checks in authorize(),
    // or check existing rows within this database transaction.
    updateBatch: async (batch: CrudEntry[], _auth: AuthContext) => {
      // Transactions require a replica set or sharded cluster.
      const session = client.startSession();
      try {
        session.startTransaction();

        for (const [operationIndex, op] of batch.entries()) {
          try {
            // Reject the transaction if a collection has no discovered validator.
            // See docs/schema-mapping.md.
            if (schema && !schema[op.table]) {
              throw new FatalOperationError(
                'SCHEMA_MISMATCH',
                `No MongoDB schema validator for collection "${op.table}" — transaction rejected.`
              );
            }

            const mapped = resolvedMapper(op);
            if (mapped === null) continue;

            const collection = db.collection(mapped.table);

            if (mapped.op == 'PUT') {
              const doc: Record<string, unknown> = { _id: mapped.id, ...mapped.data };
              await collection.replaceOne({ _id: mapped.id as unknown as mongo.ObjectId }, doc, {
                upsert: true,
                session
              });
            } else if (mapped.op == 'PATCH') {
              await collection.updateOne(
                { _id: mapped.id as unknown as mongo.ObjectId },
                { $set: mapped.data },
                { session }
              );
            } else if (mapped.op == 'DELETE') {
              await collection.deleteOne({ _id: mapped.id as unknown as mongo.ObjectId }, { session });
            }
          } catch (error) {
            const classified = classifyMongoError(error);
            if (classified instanceof FatalOperationError) classified.operationIndex = operationIndex;
            throw classified;
          }
        }

        await session.commitTransaction();
      } catch (e) {
        // A failing abort must not mask the failure that caused it.
        await session.abortTransaction().catch(() => {});
        // Preserve application error classifications. Reclassifying a fatal error without
        // a driver code would incorrectly mark it as retryable.
        throw e instanceof FatalOperationError || e instanceof RetryableError ? e : classifyMongoError(e);
      } finally {
        await session.endSession();
      }
    }
  };

  return persister;
};
