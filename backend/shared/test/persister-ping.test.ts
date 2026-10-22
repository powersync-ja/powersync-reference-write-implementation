import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgConnect: vi.fn(),
  mssqlBegin: vi.fn(),
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
      connect = db.pgConnect;
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
      transaction() {
        return { begin: db.mssqlBegin, rollback: async () => {} };
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
import { classifyMongoError } from '../src/persistence/mongo/mongo-errors.ts';
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

// Credentials, DNS and TLS problems at connect time are environment faults that an operator can
// fix; the client must keep the transaction queued rather than have it dead-lettered.
describe('connection acquisition failures are retryable', () => {
  const batch = [{ op: 'DELETE' as const, table: 'items', id: '1' }];
  const auth = { sub: 'u', claims: {} };

  it('postgres, for network and authentication errors', async () => {
    const persister = createPostgresPersister('postgres://u:p@h:5432/d');
    for (const code of ['ECONNREFUSED', '28P01', '3D000', 'XX000']) {
      db.pgConnect.mockRejectedValue(Object.assign(new Error(`connect failed ${code}`), { code }));

      await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
    }
  });

  it('mysql, for network and authentication errors', async () => {
    const persister = createMySQLPersister('mysql://u:p@h:3306/d');
    for (const error of [{ code: 'ECONNREFUSED' }, { errno: 1045, sqlState: '28000' }, { errno: 1049, sqlState: '42000' }]) {
      db.mysqlGetConnection.mockRejectedValue(Object.assign(new Error('connect failed'), error));

      await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
    }
  });

  it('mssql, when the transaction cannot start', async () => {
    const persister = await createMSSQLPersister('mssql://u:p@h:1433/d');
    for (const error of [{ code: 'ESOCKET' }, { number: 18456 }]) {
      db.mssqlBegin.mockRejectedValue(Object.assign(new Error('login failed'), error));

      await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
    }
  });

  it('mongodb, for server selection and authentication errors', () => {
    expect(classifyMongoError(Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' }))).toBeInstanceOf(RetryableError);
    expect(classifyMongoError(Object.assign(new Error('Authentication failed'), { code: 18 }))).toBeInstanceOf(RetryableError);
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
