import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { FatalOperationError, RetryableError } from './src/errors.js';
const db = vi.hoisted(() => ({
  operation: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  schema: vi.fn(),
  persist: vi.fn(),
  connect: vi.fn(),
  begin: vi.fn(),
  release: vi.fn()
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      on() {}
      async connect() {
        await db.connect();
        return {
          query: async (sql: string) => {
            if (sql === 'COMMIT') return db.commit();
            if (sql === 'ROLLBACK') return db.rollback();
            if (sql === 'BEGIN') return db.begin();
            if (sql.startsWith('SELECT set_config')) return;
            return db.operation();
          },
          release: db.release
        };
      }
    }
  }
}));
vi.mock('mysql2/promise', () => ({
  default: {
    createPool: () => ({
      getConnection: async () => ({
        beginTransaction: async () => {},
        execute: db.operation,
        commit: db.commit,
        rollback: db.rollback,
        release() {}
      })
    })
  }
}));
vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      on() {}
      async connect() {}
      transaction() {
        return {
          begin: async () => {},
          commit: db.commit,
          rollback: db.rollback,
          request: () => ({ input() {}, query: db.operation })
        };
      }
    }
  }
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() {}
    db() {
      return { collection: () => ({ replaceOne: db.operation, updateOne: db.operation, deleteOne: db.operation }) };
    }
    startSession() {
      return {
        startTransaction() {},
        commitTransaction: db.commit,
        abortTransaction: db.rollback,
        endSession: async () => {}
      };
    }
  }
}));
vi.mock('./src/persistence/mongo/mongo-schema.js', () => ({ discoverSchema: db.schema }));
vi.mock('./src/persistence/persister.js', () => ({ getPersister: async () => ({ updateBatch: db.persist }) }));
vi.mock('./src/auth/authorizer.js', () => ({ authorizer: { authorize: () => true } }));
vi.mock('./src/auth/verifier.js', () => ({ verifier: { verify: async () => ({ sub: 'verified', claims: {} }) } }));
import app from './app.js';
import { createPostgresPersister } from './src/persistence/postgres/postgres-persistence.js';
import { createMySQLPersister } from './src/persistence/mysql/mysql-persistence.js';
import { createMSSQLPersister } from './src/persistence/mssql/mssql-persistence.js';
import { createMongoPersister } from './src/persistence/mongo/mongo-persistence.js';
import type { EntryMapper } from './src/mapping/types.js';
import { defaultMapper } from './src/mapping/default.js';

const batch = [
  { op: 'DELETE' as const, id: '1', table: 'items' },
  { op: 'DELETE' as const, id: '2', table: 'items' }
];
const auth = { sub: 'verified', claims: {} };
beforeEach(() => {
  db.operation.mockReset().mockResolvedValue(undefined);
  db.commit.mockReset().mockResolvedValue(undefined);
  db.rollback.mockReset().mockResolvedValue(undefined);
  db.schema.mockReset().mockResolvedValue({});
  db.connect.mockReset().mockResolvedValue(undefined);
  db.begin.mockReset().mockResolvedValue(undefined);
  db.release.mockReset();
});
describe('Postgres connection recovery', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '08006'])(
    'retries acquisition failure %s without transaction cleanup',
    async (code) => {
      db.connect.mockRejectedValueOnce(Object.assign(new Error('connection unavailable'), { code }));
      const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db');
      await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
      expect(db.begin).not.toHaveBeenCalled();
      expect(db.rollback).not.toHaveBeenCalled();
      expect(db.release).not.toHaveBeenCalled();
    }
  );
  it('keeps bad credentials fatal on acquisition', async () => {
    db.connect.mockRejectedValueOnce(Object.assign(new Error('bad credentials'), { code: '28P01' }));
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db');
    await expect(persister.updateBatch(batch, auth)).rejects.toMatchObject({ errorCode: 'UNCLASSIFIED_ERROR' });
    expect(db.release).not.toHaveBeenCalled();
  });
  it('rolls back and releases when the connection resets during commit', async () => {
    db.commit.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db');
    await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('returns retryable_error through the actual API when acquiring a connection fails', async () => {
    const { fatalErrorHandler } = await import('./src/fatal-error-handler.js');
    const notify = vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {});
    try {
      db.connect.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
      db.persist.mockImplementation(createPostgresPersister('postgres://user:pass@localhost:5432/db').updateBatch);
      const response = await request(app)
        .post('/api/data')
        .set('Authorization', 'Bearer test')
        .send({ transactions: [{ crud: batch }] });
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([{ status: 'retryable_error', message: 'connection refused' }]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      notify.mockRestore();
    }
  });
});
for (const [name, factory] of [
  ['postgres', createPostgresPersister],
  ['mysql', createMySQLPersister],
  ['mssql', createMSSQLPersister],
  ['mongo', createMongoPersister]
] as const) {
  describe(`${name} operation context`, () => {
    it.each(['mapper', 'driver'])('preserves application errors from the %s and rolls back', async (source) => {
      const error = new FatalOperationError('CUSTOM', 'rejected', { value: 7 });
      const mapper: EntryMapper = (op) => {
        if (source === 'mapper' && op.id === '2') throw error;
        return defaultMapper(op);
      };
      if (source === 'driver') db.operation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
      const persister = await factory('postgres://user:pass@localhost:5432/db', mapper);
      await expect(persister.updateBatch(batch, auth)).rejects.toBe(error);
      expect(error.operationIndex).toBe(1);
      expect(error.details).toEqual({ value: 7 });
      expect(db.rollback).toHaveBeenCalledOnce();
      expect(db.commit).not.toHaveBeenCalled();
    });
    it('does not attribute a commit failure to an operation', async () => {
      const error = new FatalOperationError('COMMIT_FAILED', 'commit failed');
      db.commit.mockRejectedValueOnce(error);
      const persister = await factory('postgres://user:pass@localhost:5432/db', defaultMapper);
      await expect(persister.updateBatch(batch, auth)).rejects.toBe(error);
      expect(error.operationIndex).toBeUndefined();
    });
  });
}
it('Mongo missing-schema failure rolls back before shared routing once', async () => {
  const { fatalErrorHandler } = await import('./src/fatal-error-handler.js');
  const notify = vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {
    expect(db.rollback).toHaveBeenCalledOnce();
  });
  const persister = await createMongoPersister('mongodb://localhost/db');
  db.persist.mockImplementation(persister.updateBatch);
  const response = await request(app)
    .post('/api/data')
    .set('Authorization', 'Bearer test')
    .send({ transactions: [{ crud: batch }] });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.results[0]).toMatchObject({
    status: 'fatal_error',
    requires_client_handling: false,
    failed_operation: { error_code: 'SCHEMA_MISMATCH', operation_index: 0 }
  });
  expect(notify).toHaveBeenCalledOnce();
  expect(db.operation).not.toHaveBeenCalled();
  notify.mockRestore();
});
