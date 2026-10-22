import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  mysqlQuery: vi.fn(),
  mysqlGetConnection: vi.fn(),
  mssqlQuery: vi.fn(),
  mongoCommand: vi.fn()
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      on() {}
      query = db.pgQuery;
    }
  }
}));
vi.mock('mysql2/promise', () => ({
  default: { createPool: () => ({ query: db.mysqlQuery, getConnection: db.mysqlGetConnection }) }
}));
vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      on() {}
      async connect() {}
      request() {
        return { query: db.mssqlQuery };
      }
    }
  }
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() {}
    db() {
      return { command: db.mongoCommand };
    }
  }
}));

import { createPostgresPersister } from '../src/persistence/postgres/postgres-persistence.ts';
import { createMySQLPersister } from '../src/persistence/mysql/mysql-persistence.ts';
import { createMSSQLPersister } from '../src/persistence/mssql/mssql-persistence.ts';
import { createMongoPersister } from '../src/persistence/mongo/mongo-persistence.ts';
import { RetryableError } from '../src/errors.ts';
import type { Persister } from '../src/types.ts';

const passthroughMapper = () => null;

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset().mockResolvedValue(undefined);
});

const persisters: [string, () => Promise<Persister>, () => ReturnType<typeof vi.fn>][] = [
  ['postgres', async () => createPostgresPersister('postgres://u:p@h:5432/d'), () => db.pgQuery],
  ['mysql', async () => createMySQLPersister('mysql://u:p@h:3306/d'), () => db.mysqlQuery],
  ['mssql', () => createMSSQLPersister('mssql://u:p@h:1433/d'), () => db.mssqlQuery],
  ['mongodb', () => createMongoPersister('mongodb://h/d', passthroughMapper), () => db.mongoCommand]
];

describe.each(persisters)('%s ping', (_name, create, probe) => {
  it('resolves when the database answers', async () => {
    const persister = await create();

    await expect(persister.ping()).resolves.toBeUndefined();
    expect(probe()).toHaveBeenCalledTimes(1);
  });

  it('rejects when the database is unreachable', async () => {
    const persister = await create();
    probe().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    await expect(persister.ping()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('MySQL connection acquisition', () => {
  it('classifies a failure to get a connection instead of throwing it raw', async () => {
    const persister = createMySQLPersister('mysql://u:p@h:3306/d');
    db.mysqlGetConnection.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    await expect(persister.updateBatch([{ op: 'DELETE', table: 'items', id: '1' }], { sub: 'u', claims: {} })).rejects.toBeInstanceOf(
      RetryableError
    );
  });
});
