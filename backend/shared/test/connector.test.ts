import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('uuid', () => ({ v4: () => 'test-user' }));
vi.mock('../../../example-client/src/library/powersync/OpenAPITransport', () => ({
  AuthenticationError: class extends Error {},
  createOpenAPIClient: () => ({ transport: {} })
}));
vi.mock('../../../example-client/src/library/powersync/DemoConnectorConfig', () => ({
  readDemoConfig: () => ({
    backendUrl: '',
    batching: { maxTransactions: 3, maxOperations: 100 }
  }),
  USER_ID_STORAGE_KEY: 'user',
  DEFAULT_BATCHING_CONFIG: {}
}));
// Reference clients use their host application's dependencies and module resolution.
const { WriteAPIClient } = await import(
  new URL('../../../example-client/src/library/powersync/WriteAPIClient.ts', import.meta.url).href
);
const splitPath = '../../../example-client/src/PowersyncConnector.ts';
const singlePath = '../../../example-client/src/PowersyncConnector.singlefile.ts';
const { PowersyncConnector: Split } = await import(new URL(splitPath, import.meta.url).href);
const { PowersyncConnector: Single } = await import(new URL(singlePath, import.meta.url).href);

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'user' }));

for (const [name, Connector] of [
  ['split', Split],
  ['single', Single]
] as const) {
  describe(`${name} connector queue completion`, () => {
    async function upload(results: unknown[], decision: unknown = 'retain') {
      const connector = new Connector();
      const hook = vi.fn(async () => {
        if (decision instanceof Error) throw decision;
        return decision;
      });
      const batch = [1, 2, 3].map((id) => ({
        crud: [{ id: String(id), table: 'items', op: 'PUT' }],
        complete: vi.fn(async () => {})
      }));
      const post = vi.fn(async () => ({
        results: results.map((r: any) => ({
          ...r,
          requires_client_handling: r.requiresClientHandling,
          failed_operation: r.failedOperation
        }))
      }));
      // Mock transport and configuration while exercising serialization and result handling.
      Object.assign(connector, {
        getBatchingConfig: () => ({ maxTransactions: 3, maxOperations: 100 }),
        onFatalTransaction: hook,
        getWriteClient: async () =>
          new WriteAPIClient({
            transport: { postTransactionBatch: post },
            userId: 'user',
            clientId: 'client'
          }),
        postTransactionBatch: post
      });
      const database = {
        getClientId: async () => 'client',
        async *getCrudTransactions() {
          yield* batch;
        }
      };
      let error: unknown;
      try {
        await connector.uploadData(database as any);
      } catch (e) {
        error = e;
      }
      return { batch, hook, error, post };
    }
    const success = { status: 'success' };
    const fatal = {
      status: 'fatal_error',
      requiresClientHandling: true,
      failedOperation: { error_code: 'CUSTOM', details: { record_id: '2' } }
    };
    const suffix = { status: 'not_attempted' };

    it('sends transactions without a fatal-error policy', async () => {
      const { batch, error, post } = await upload([success, success, success]);
      expect(error).toBeUndefined();
      expect(post).toHaveBeenCalledExactlyOnceWith({
        transactions: batch.map(({ crud }) => ({ crud }))
      });
    });

    it.each(['retain', 'invalid', new Error('callback failed')])(
      'retains with decision %s and completes earlier success',
      async (decision) => {
        const { batch, hook, error } = await upload([success, fatal, suffix], decision);
        expect(error).toBeTruthy();
        expect(hook).toHaveBeenCalledOnce();
        expect(batch[0].complete).toHaveBeenCalledOnce();
        expect(batch[1].complete).not.toHaveBeenCalled();
        expect(batch[2].complete).not.toHaveBeenCalled();
      }
    );
    it('explicitly completes a client-directed failure', async () => {
      const { batch, error } = await upload([success, fatal, suffix], 'complete');
      expect(error).toBeUndefined();
      expect(batch[1].complete).toHaveBeenCalledOnce();
      expect(batch[0].complete).not.toHaveBeenCalled();
      expect(batch[2].complete).not.toHaveBeenCalled();
    });
    it('completes backend-directed failures without a callback', async () => {
      const { batch, hook, error } = await upload([success, { ...fatal, requiresClientHandling: false }, success]);
      expect(error).toBeUndefined();
      expect(hook).not.toHaveBeenCalled();
      expect(batch[2].complete).toHaveBeenCalledOnce();
    });
    it.each([
      { status: 'fatal_error', failedOperation: { error_code: 'CUSTOM' } },
      { status: 'fatal_error', requiresClientHandling: false },
      { ...fatal, requiresClientHandling: 'false' },
      { ...fatal, failedOperation: {} }
    ])('retains malformed fatal results', async (malformed) => {
      const { batch, hook, error } = await upload([success, malformed, success]);
      expect(error).toBeTruthy();
      expect(hook).not.toHaveBeenCalled();
      expect(batch[0].complete).toHaveBeenCalledOnce();
      expect(batch[2].complete).not.toHaveBeenCalled();
    });
    describe('retry backoff and limit', () => {
      const retryable = { status: 'retryable_error', message: 'deadlock' };
      afterEach(() => vi.useRealTimers());

      function setup(respond: () => unknown) {
        vi.useFakeTimers();
        const connector = new Connector();
        const tx = { crud: [{ id: '1', table: 'items', op: 'PUT', clientId: 7 }], complete: vi.fn(async () => {}) };
        const hook = vi.fn(async () => 'retain');
        Object.assign(connector, {
          getBatchingConfig: () => ({ maxTransactions: 1, maxOperations: 100 }),
          onFatalTransaction: hook,
          getWriteClient: async () =>
            new WriteAPIClient({
              transport: { postTransactionBatch: async () => respond() },
              userId: 'user',
              clientId: 'client'
            }),
          postTransactionBatch: async () => respond()
        });
        const database = {
          getClientId: async () => 'client',
          async *getCrudTransactions() {
            yield tx;
          }
        };
        const attempt = async () => {
          const outcome = connector.uploadData(database as any).then(
            () => undefined,
            (e: unknown) => e
          );
          await vi.advanceTimersByTimeAsync(120_000);
          return outcome;
        };
        return { tx, hook, attempt };
      }

      it('uses retry_after_ms as the minimum backoff', async () => {
        const { attempt } = setup(() => ({ results: [{ ...retryable, retry_after_ms: 90_000 }] }));
        const spy = vi.spyOn(globalThis, 'setTimeout');
        expect(await attempt()).toBeTruthy();
        expect(spy.mock.calls.some(([, ms]) => ms === 90_000)).toBe(true);
      });
      it('escalates to onFatalTransaction at the retry limit, then restarts the count', async () => {
        const { tx, hook, attempt } = setup(() => ({ results: [retryable] }));
        for (let i = 0; i < 9; i++) expect(await attempt()).toBeTruthy();
        expect(hook).not.toHaveBeenCalled();
        expect(await attempt()).toBeTruthy();
        expect(hook).toHaveBeenCalledOnce();
        expect(hook.mock.calls[0][1]).toMatchObject({ failedOperation: { error_code: 'RETRY_LIMIT_EXCEEDED' } });
        expect(tx.complete).not.toHaveBeenCalled();
        for (let i = 0; i < 9; i++) await attempt();
        expect(hook).toHaveBeenCalledOnce();
      });
      it('does not count transport errors toward the limit', async () => {
        const { hook, attempt } = setup(() => {
          throw new Error('offline');
        });
        for (let i = 0; i < 15; i++) expect(await attempt()).toBeTruthy();
        expect(hook).not.toHaveBeenCalled();
      });
    });
    it('retains retryable errors and their suffix', async () => {
      const { batch, error } = await upload([success, { status: 'retryable_error' }, suffix]);
      expect(error).toBeTruthy();
      expect(batch[0].complete).toHaveBeenCalledOnce();
      expect(batch[1].complete).not.toHaveBeenCalled();
    });
  });
}
