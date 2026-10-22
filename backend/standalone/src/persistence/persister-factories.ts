import { createMongoPersister } from '../../../shared/src/persistence/mongo/mongo-persistence.ts';
import { createMySQLPersister } from '../../../shared/src/persistence/mysql/mysql-persistence.ts';
import { createPostgresPersister } from '../../../shared/src/persistence/postgres/postgres-persistence.ts';
import { createMSSQLPersister } from '../../../shared/src/persistence/mssql/mssql-persistence.ts';
import type { PersisterFactory } from '../../../shared/src/types.ts';

// Edit entries here, for example to install a custom mapper. The transaction processor validates
// client table and column names before any of these run.
export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: createMySQLPersister,
  mssql: createMSSQLPersister
};
