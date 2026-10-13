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
  release: vi.fn(),
  input: vi.fn()
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
          request: () => ({ input: db.input, query: db.operation })
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
import { factories } from './src/persistence/persister-factories.js';
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
  db.input.mockReset();
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

describe.each(['postgres', 'mysql', 'mssql', 'mongodb'])('%s identifier validation', (name) => {
  it.each([
    ['table', { op: 'PUT' as const, id: '1', table: 'items; DROP TABLE users', op_data: { a: 1 } }],
    ['schema-qualified table', { op: 'PUT' as const, id: '1', table: 'other.items', op_data: { a: 1 } }],
    ['bracket in column', { op: 'PATCH' as const, id: '1', table: 'items', op_data: { 'a]; DROP TABLE x--': 1 } }],
    ['operator column', { op: 'PATCH' as const, id: '1', table: 'items', op_data: { $where: 1 } }]
  ])('rejects a hostile %s before any database work', async (_label, hostile) => {
    const persister = await factories[name]('postgres://user:pass@localhost:5432/db');
    const error = await persister.updateBatch([batch[0], hostile], auth).catch((e) => e);
    expect(error).toBeInstanceOf(FatalOperationError);
    expect(error).toMatchObject({ errorCode: 'INVALID_DATA', operationIndex: 1 });
    // The whole transaction is refused up front: not even the valid first operation runs.
    expect(db.operation).not.toHaveBeenCalled();
    expect(db.begin).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('passes safe transactions and a custom mapper through', async () => {
    const mapper: EntryMapper = (op) => ({ table: 'renamed', op: op.op, id: op.id, data: {} });
    db.schema.mockResolvedValue({ renamed: {} });
    const persister = await factories[name]('postgres://user:pass@localhost:5432/db', mapper);
    await persister.updateBatch(batch, auth);
    expect(db.commit).toHaveBeenCalledOnce();
  });
});

describe.each([
  ['postgres', '"'],
  ['mysql', '`'],
  ['mssql', '['],
  ['mssql', ']']
])('%s mapper output containing %s', (name, quote) => {
  it.each([
    ['table', { table: `we${quote}ird`, data: { a: 1 } }],
    ['column', { table: 'items', data: { [`col${quote}x`]: 1 } }]
  ])('is refused in a %s name', async (_label, mapped) => {
    const mapper: EntryMapper = (op) => ({ ...mapped, op: op.op, id: op.id });
    const persister = await factories[name]('postgres://user:pass@localhost:5432/db', mapper);
    const error = await persister
      .updateBatch([{ op: 'PUT', id: '7', table: 'items', op_data: { a: 1 } }], auth)
      .catch((e) => e);
    expect(error).toMatchObject({ errorCode: 'INVALID_DATA', operationIndex: 0 });
    expect(db.operation).not.toHaveBeenCalled();
    expect(db.commit).not.toHaveBeenCalled();
  });
});

describe('mssql statements', () => {
  it('uses positional parameters', async () => {
    const mapper: EntryMapper = (op) => ({ table: 'renamed', op: op.op, id: op.id, data: { 'col x': 1, plain: 2 } });
    const persister = await createMSSQLPersister('mssql://user:pass@localhost:1433/db', mapper);
    await persister.updateBatch([{ op: 'PATCH', id: '7', table: 'items', op_data: { a: 1 } }], auth);
    const sql = db.operation.mock.calls[0][0] as string;
    expect(sql).toContain('[renamed]');
    expect(sql).toContain('[col x] = @p0');
    expect(sql).toContain('[plain] = @p1');
    expect(db.input.mock.calls).toEqual([
      ['p0', 1],
      ['p1', 2],
      ['id', '7']
    ]);
  });
});
