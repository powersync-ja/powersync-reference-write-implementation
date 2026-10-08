import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { FatalOperationError, RetryableError } from './src/errors.js';

const mocks = vi.hoisted(() => ({ updateBatch: vi.fn(), authorize: vi.fn(), verify: vi.fn() }));
vi.mock('./src/persistence/persister.js', () => ({ getPersister: async () => ({ updateBatch: mocks.updateBatch }) }));
vi.mock('./src/auth/authorizer.js', () => ({ authorizer: { authorize: mocks.authorize } }));
vi.mock('./src/auth/verifier.js', () => ({ verifier: { verify: mocks.verify } }));
import app from './app.js';
import config from './config.js';
import { fatalErrorHandler } from './src/fatal-error-handler.js';

const transactions = [1, 2, 3].map((id) => ({
  transaction_id: id,
  crud: [{ op: 'PUT', table: 'items', id: String(id) }]
}));
const post = (mode: 'stop' | 'skip' = 'stop', legacyMode?: 'stop' | 'skip') => {
  vi.spyOn(config, 'batchOnFatalError', 'get').mockReturnValue(mode);
  return request(app)
    .post('/api/data')
    .set('Authorization', 'Bearer test')
    .send({ transactions, ...(legacyMode === undefined ? {} : { on_fatal_error: legacyMode }) });
};
const fatal = () => new FatalOperationError('USER_CONFIRMATION_REQUIRED', 'Confirm', { record_id: '2' }, 0);

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.updateBatch.mockReset().mockResolvedValue(undefined);
  mocks.authorize.mockReset().mockResolvedValue(true);
  mocks.verify.mockReset().mockResolvedValue({ sub: 'verified', claims: {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fatal routing over HTTP', () => {
  it.each(['stop', 'skip'] as const)('ignores a conflicting legacy policy when the backend uses %s', async (mode) => {
    vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {});
    mocks.updateBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(fatal());
    const res = await post(mode, mode === 'stop' ? 'skip' : 'stop');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'success',
      'fatal_error',
      mode === 'skip' ? 'success' : 'not_attempted'
    ]);
    expect(mocks.updateBatch).toHaveBeenCalledTimes(mode === 'skip' ? 3 : 2);
  });

  it.each(['stop', 'skip'] as const)('defaults to backend handling with %s', async (mode) => {
    const handler = vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {});
    mocks.updateBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(fatal());
    const res = await post(mode);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'success',
      'fatal_error',
      mode === 'skip' ? 'success' : 'not_attempted'
    ]);
    expect(res.body.results[1]).toMatchObject({
      requires_client_handling: false,
      failed_operation: { error_code: 'USER_CONFIRMATION_REQUIRED', details: { record_id: '2' }, operation_index: 0 }
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      transaction: transactions[1],
      authenticatedSubject: 'verified',
      operationIndex: 0
    });
    expect(handler.mock.calls[0][0].occurrenceId).toBeTruthy();
  });

  it.each(['stop', 'skip'] as const)('stops client-directed errors under %s', async (mode) => {
    const classifier = vi.spyOn(fatalErrorHandler, 'requiresClientHandling').mockResolvedValue(true);
    const handler = vi.spyOn(fatalErrorHandler, 'onDeadLetter');
    mocks.updateBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(fatal());
    const res = await post(mode);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'success',
      'fatal_error',
      'not_attempted'
    ]);
    expect(res.body.results[1].requires_client_handling).toBe(true);
    expect(classifier).toHaveBeenCalledWith(expect.any(FatalOperationError), {
      transaction: transactions[1],
      auth: { sub: 'verified', claims: {} }
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject', 'pending'])('does not await a handler that will %s', async (behavior) => {
    vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {
      if (behavior === 'throw') throw new Error('notification failed');
      if (behavior === 'reject') return Promise.reject(new Error('notification failed'));
      return new Promise<void>(() => {});
    });
    mocks.updateBatch.mockRejectedValueOnce(fatal());
    const res = await post('skip').timeout(2000);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['fatal_error', 'success', 'success']);
  });

  it.each(['stop', 'skip'] as const)('retries and stops when classification fails under %s', async (mode) => {
    vi.spyOn(fatalErrorHandler, 'requiresClientHandling').mockRejectedValue(new Error('routing unavailable'));
    const handler = vi.spyOn(fatalErrorHandler, 'onDeadLetter');
    mocks.updateBatch.mockRejectedValueOnce(fatal());
    const res = await post(mode);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'retryable_error',
      'not_attempted',
      'not_attempted'
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['stop', 'skip'] as const)(
    'routes authorization rejection and preserves transient classification under %s',
    async (mode) => {
      const handler = vi.spyOn(fatalErrorHandler, 'onDeadLetter').mockImplementation(() => {});
      mocks.authorize.mockResolvedValueOnce(false);
      const denied = await post();
      expect(denied.body.results[0].failed_operation.error_code).toBe('UNAUTHORIZED');
      expect(mocks.updateBatch).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
      mocks.updateBatch.mockRejectedValueOnce(new RetryableError('timeout'));
      const retry = await post(mode);
      expect(retry.body.results.map((r: { status: string }) => r.status)).toEqual([
        'retryable_error',
        'not_attempted',
        'not_attempted'
      ]);
      expect(handler).toHaveBeenCalledOnce();
    }
  );
});
