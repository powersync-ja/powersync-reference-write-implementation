import * as mongo from 'mongodb';
import type { AuthContext, Persister, CrudEntry } from '../../types.ts';
import { classifyMongoError } from './mongo-errors.ts';
import type { EntryMapper } from '../../mapping/types.ts';
import { createMongoMapper } from '../../mapping/mongo.ts';
import { convertId, discoverCollections } from './mongo-schema.ts';
import { FatalOperationError, RetryableError } from '../../errors.ts';

export const createMongoPersister = async (uri: string, mapper?: EntryMapper): Promise<Persister> => {
  console.debug('Using MongoDB Persister');

  const client = new mongo.MongoClient(uri);
  const db = client.db();
  await client.connect();

  // Validators are always discovered: they declare each collection's _id type, which row IDs must
  // be converted to. Only the default mapper also uses them for field validation and requires them.
  const { schema, idConverters } = await discoverCollections(db);
  const resolvedMapper = mapper ?? createMongoMapper(schema);

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
            if (!mapper && !schema[op.table]) {
              throw new FatalOperationError(
                'SCHEMA_MISMATCH',
                `No MongoDB schema validator for collection "${op.table}" — transaction rejected.`
              );
            }

            const mapped = resolvedMapper(op);
            if (mapped === null) continue;

            const collection = db.collection(mapped.table);
            const id = convertId(idConverters, mapped.table, mapped.id) as mongo.ObjectId;

            if (mapped.op == 'PUT') {
              // Upsert that overwrites only the provided fields, like the SQL adapters. $set rejects
              // an empty document, so a PUT with no fields only ensures the document exists.
              const update = Object.keys(mapped.data).length > 0 ? { $set: mapped.data } : { $setOnInsert: {} };
              await collection.updateOne({ _id: id }, update, { upsert: true, session });
            } else if (mapped.op == 'PATCH') {
              await collection.updateOne({ _id: id }, { $set: mapped.data }, { session });
            } else if (mapped.op == 'DELETE') {
              await collection.deleteOne({ _id: id }, { session });
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
