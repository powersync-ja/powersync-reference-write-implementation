import { createMongoPersister } from './mongo/mongo-persistence.js';
import { createMySQLPersister } from './mysql/mysql-persistence.js';
import { createPostgresPersister } from './postgres/postgres-persistence.js';
import { createMSSQLPersister } from './mssql/mssql-persistence.js';
import type { PersisterFactory } from '../types.js';

export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: createMySQLPersister,
  mssql: createMSSQLPersister
};
