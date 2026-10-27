import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { FatalOperationError, RetryableError } from '../../shared/src/errors.ts';
const db = vi.hoisted(() => ({
  operation: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  schema: vi.fn(),
  persist: vi.fn(),
  connect: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
  poolConfig: vi.fn(),
  setConfig: vi.fn(),
  input: vi.fn()
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(config: unknown) {
        db.poolConfig(config);
      }
      on() {}
      async connect() {
        await db.connect();
        return {
          query: async (sql: string, params?: unknown[]) => {
            if (sql === 'COMMIT') return db.commit();
            if (sql === 'ROLLBACK') return db.rollback();
            if (sql === 'BEGIN') return db.begin();
            if (sql.startsWith('SELECT set_config')) return db.setConfig(sql, params);
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
      return { collection: () => ({ updateOne: db.operation, deleteOne: db.operation }) };
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
vi.mock('../../shared/src/persistence/mongo/mongo-schema.ts', () => ({
  discoverCollections: async () => ({ schema: await db.schema(), idConverters: {} }),
  convertId: (_converters: unknown, _table: string, id: string) => id
}));
vi.mock('../src/persistence/persister.ts', () => ({ getPersister: async () => ({ updateBatch: db.persist }) }));
vi.mock('../src/auth/authorizer.ts', () => ({ authorizer: { authorize: () => true } }));
vi.mock('../src/auth/verifier.ts', () => ({ verifier: { verify: async () => ({ sub: 'verified', claims: {} }) } }));
import app from '../app.ts';
import { createPostgresPersister } from '../../shared/src/persistence/postgres/postgres-persistence.ts';
import { createMySQLPersister } from '../../shared/src/persistence/mysql/mysql-persistence.ts';
import { createMSSQLPersister } from '../../shared/src/persistence/mssql/mssql-persistence.ts';
import { createMongoPersister } from '../../shared/src/persistence/mongo/mongo-persistence.ts';
import { factories } from '../src/persistence/persister-factories.ts';
import { createTransactionProcessor } from '../../shared/src/write/processor.ts';
import type { EntryMapper } from '../../shared/src/mapping/types.ts';
import { defaultMapper } from '../../shared/src/mapping/default.ts';

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
  db.poolConfig.mockReset();
  db.setConfig.mockReset();
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
  it('discards the connection when rollback fails', async () => {
    db.operation.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    db.rollback.mockRejectedValueOnce(new Error('connection terminated'));
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db');
    await expect(persister.updateBatch(batch, auth)).rejects.toBeInstanceOf(RetryableError);
    expect(db.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection terminated' }));
  });
  it('returns a healthy connection to the pool after rollback', async () => {
    db.operation.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db');
    await expect(persister.updateBatch(batch, auth)).rejects.toMatchObject({ errorCode: 'UNIQUE_VIOLATION' });
    expect(db.release).toHaveBeenCalledWith(undefined);
  });
  it('passes the full connection string and pool settings to pg', () => {
    const uri = 'postgres://us%40er:p%3Ass@db.example.com:6543/postgres?sslmode=verify-full';
    createPostgresPersister(uri, defaultMapper, { pool: { max: 2, statement_timeout: 5000 } });
    expect(db.poolConfig).toHaveBeenLastCalledWith({
      connectionString: uri,
      max: 2,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5000
    });
  });
  it('sets request.jwt.claims by default and runs a custom transaction initializer instead when given', async () => {
    const withClaims = { sub: 'verified', claims: { sub: 'verified', role: 'authenticated' } };
    await createPostgresPersister('postgres://user:pass@localhost:5432/db').updateBatch(batch, withClaims);
    // The default 30 s statement timeout, then the verified claims as JSON.
    expect(db.setConfig.mock.calls.map(([, params]) => params)).toEqual([
      ['30000'],
      ['request.jwt.claims', JSON.stringify(withClaims.claims)]
    ]);

    db.setConfig.mockReset();
    const initializeTransaction = vi.fn().mockResolvedValue(undefined);
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db', defaultMapper, {
      initializeTransaction
    });
    await persister.updateBatch(batch, auth);
    expect(initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), auth);
    expect(db.setConfig.mock.calls.map(([, params]) => params)).toEqual([['30000']]);
    expect(db.begin.mock.invocationCallOrder[1]).toBeLessThan(initializeTransaction.mock.invocationCallOrder[0]);
  });
  it('applies statement_timeout inside each transaction, because transaction poolers drop startup parameters', async () => {
    const initializeTransaction = vi.fn().mockResolvedValue(undefined);
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db', defaultMapper, {
      pool: { statement_timeout: 10_000 },
      initializeTransaction
    });
    await persister.updateBatch(batch, auth);
    expect(db.setConfig).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("'statement_timeout'"), ['10000']);
    expect(db.begin.mock.invocationCallOrder[0]).toBeLessThan(db.setConfig.mock.invocationCallOrder[0]);
    expect(db.setConfig.mock.invocationCallOrder[0]).toBeLessThan(initializeTransaction.mock.invocationCallOrder[0]);
  });
  it('rolls back when transaction initialization fails', async () => {
    const persister = createPostgresPersister('postgres://user:pass@localhost:5432/db', defaultMapper, {
      initializeTransaction: () => Promise.reject(Object.assign(new Error('role missing'), { code: '42704' }))
    });
    await expect(persister.updateBatch(batch, auth)).rejects.toMatchObject({ errorCode: 'SCHEMA_MISMATCH' });
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.operation).not.toHaveBeenCalled();
  });
  it('returns retryable_error through the actual API when acquiring a connection fails', async () => {
    const { fatalErrorHandler } = await import('../src/fatal-error-handler.ts');
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
  const { fatalErrorHandler } = await import('../src/fatal-error-handler.ts');
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
    const process = createTransactionProcessor({
      persister: () => factories[name]('postgres://user:pass@localhost:5432/db'),
      authorizer: { authorize: () => true },
      fatalErrorHandler: { requiresClientHandling: () => true, onDeadLetter: () => {} },
      batchOnFatalError: () => 'stop'
    });
    const [result] = await process([{ transaction_id: 1, crud: [batch[0], hostile] }], auth);
    expect(result).toMatchObject({
      status: 'fatal_error',
      failed_operation: { error_code: 'INVALID_DATA', operation_index: 1 }
    });
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

describe('MSSQL URI parsing', () => {
  it('decodes credentials, defaults port, verifies certificates', async () => {
    const { parseMSSQLUri } = await import('../../shared/src/persistence/mssql/mssql-persistence.ts');
    const config = parseMSSQLUri('mssql://us%40er:p%3Ass%2Fw%23rd@localhost/db');
    expect(config.user).toBe('us@er');
    expect(config.password).toBe('p:ss/w#rd');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('db');
    expect(config.options?.trustServerCertificate).toBe(false);
  });

  it('honours explicit trustServerCertificate', async () => {
    const { parseMSSQLUri } = await import('../../shared/src/persistence/mssql/mssql-persistence.ts');
    const config = parseMSSQLUri('mssql://u:p@h:1444/db?trustServerCertificate=true');
    expect(config.port).toBe(1444);
    expect(config.options?.trustServerCertificate).toBe(true);
  });
});
