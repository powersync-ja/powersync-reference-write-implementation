import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransactionProcessor, type TransactionProcessorOptions } from '../src/write/processor.ts';
import { FatalOperationError } from '../src/errors.ts';

const auth = { sub: 'verified', claims: {} };
const transactions = [1, 2].map((id) => ({
  transaction_id: id,
  crud: [{ op: 'PUT' as const, table: 'items', id: String(id) }]
}));

const setup = (overrides: Partial<TransactionProcessorOptions> = {}) => {
  const updateBatch = vi.fn().mockRejectedValueOnce(new FatalOperationError('CHECK_VIOLATION', 'bad', undefined, 0));
  const process = createTransactionProcessor({
    persister: () => ({ updateBatch, ping: async () => {} }),
    authorizer: { authorize: () => true },
    fatalErrorHandler: { requiresClientHandling: () => false, onDeadLetter: () => {} },
    batchOnFatalError: () => 'skip',
    ...overrides
  });
  return { process, updateBatch };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('createTransactionProcessor', () => {
  it('awaits dead-letter delivery when configured', async () => {
    const events: string[] = [];
    const onDeadLetter = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('dead-letter');
    };
    const { process } = setup({
      awaitDeadLetter: true,
      fatalErrorHandler: { requiresClientHandling: () => false, onDeadLetter }
    });
    const results = await process(transactions, auth);
    events.push('returned');
    expect(events).toEqual(['dead-letter', 'returned']);
    expect(results.map((r) => r.status)).toEqual(['fatal_error', 'success']);
  });

  it('does not wait for dead-letter delivery by default', async () => {
    const events: string[] = [];
    const onDeadLetter = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('dead-letter');
    };
    const { process } = setup({ fatalErrorHandler: { requiresClientHandling: () => false, onDeadLetter } });
    await process(transactions, auth);
    events.push('returned');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['returned', 'dead-letter']);
  });

  it('logs an awaited dead-letter failure without changing the result', async () => {
    const onDeadLetter = vi.fn().mockRejectedValue(new Error('storage down'));
    const { process } = setup({
      awaitDeadLetter: true,
      fatalErrorHandler: { requiresClientHandling: () => false, onDeadLetter }
    });
    const results = await process(transactions, auth);
    expect(results[0]).toMatchObject({
      status: 'fatal_error',
      failed_operation: { error_code: 'CHECK_VIOLATION', operation_index: 0 }
    });
    expect(console.error).toHaveBeenCalledWith('Dead-letter handler failed:', expect.any(Error));
  });

  it('reports a persister creation failure per transaction', async () => {
    const { process } = setup({
      persister: () => Promise.reject(new Error('no database')),
      batchOnFatalError: () => 'stop'
    });
    const results = await process(transactions, auth);
    expect(results).toMatchObject([
      { status: 'fatal_error', failed_operation: { error_code: 'UNCLASSIFIED_ERROR', message: 'no database' } },
      { status: 'not_attempted' }
    ]);
  });

  it('rejects unsafe client names before authorization and before creating the persister', async () => {
    const authorize = vi.fn().mockReturnValue(true);
    const persister = vi.fn();
    const { process } = setup({ authorizer: { authorize }, persister, batchOnFatalError: () => 'stop' });
    const crud = [
      { op: 'PUT' as const, table: 'items', id: '1', op_data: { a: 1 } },
      { op: 'PUT' as const, table: 'items', id: '2', op_data: { 'a; DROP': 1 } }
    ];
    const results = await process([{ transaction_id: 1, crud }], auth);
    expect(results[0]).toMatchObject({
      status: 'fatal_error',
      failed_operation: { error_code: 'INVALID_DATA', operation_index: 1 }
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(persister).not.toHaveBeenCalled();
  });

  it('reads the batch policy once per batch', async () => {
    const batchOnFatalError = vi.fn().mockReturnValue('skip');
    const { process } = setup({ batchOnFatalError });
    await process(transactions, auth);
    expect(batchOnFatalError).toHaveBeenCalledOnce();
  });
});
