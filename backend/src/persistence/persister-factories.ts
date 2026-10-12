import { createMongoPersister } from './mongo/mongo-persistence.ts';
import { createMySQLPersister } from './mysql/mysql-persistence.ts';
import { createPostgresPersister } from './postgres/postgres-persistence.ts';
import { createMSSQLPersister } from './mssql/mssql-persistence.ts';
import type { PersisterFactory } from '../types.ts';

export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: createMySQLPersister,
  mssql: createMSSQLPersister
};
