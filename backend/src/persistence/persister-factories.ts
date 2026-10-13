import { createMongoPersister } from './mongo/mongo-persistence.js';
import { createMySQLPersister } from './mysql/mysql-persistence.js';
import { createPostgresPersister } from './postgres/postgres-persistence.js';
import { createMSSQLPersister } from './mssql/mssql-persistence.js';
import { assertSafeTransaction } from './identifiers.js';
import type { PersisterFactory } from '../types.js';

/**
 * Wraps a factory so every persister it creates rejects unsafe client-supplied table and column
 * names before any database work starts. See docs/schema-mapping.md#identifier-validation.
 */
const withIdentifierValidation =
  (factory: PersisterFactory): PersisterFactory =>
  async (uri, mapper) => {
    const persister = await factory(uri, mapper);
    return {
      ...persister,
      updateBatch: async (batch, auth) => {
        assertSafeTransaction(batch);
        return persister.updateBatch(batch, auth);
      }
    };
  };

// Edit entries here, for example to install a custom mapper. Every entry is wrapped below.
const unvalidatedFactories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: createMySQLPersister,
  mssql: createMSSQLPersister
};

export const factories: Record<string, PersisterFactory> = Object.fromEntries(
  Object.entries(unvalidatedFactories).map(([name, factory]) => [name, withIdentifierValidation(factory)])
);
