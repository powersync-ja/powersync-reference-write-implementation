import { assertEquals, assertRejects } from '@std/assert';
import { FatalOperationError, RetryableError } from '@powersync/write-core/errors.ts';
import type { Persister } from '@powersync/write-core/types.ts';
import { permissionErrorsRetryable } from '../../functions/powersync-write/rls.ts';

const auth = { sub: 'user', claims: {} };
const failing = (error: Error): Persister => ({
  ping: () => Promise.resolve(),
  updateBatch: () => Promise.reject(error)
});

Deno.test('permission errors from the persister become retryable', async () => {
  const persister = permissionErrorsRetryable(failing(new FatalOperationError('UNAUTHORIZED', 'new row violates row-level security policy')));
  const error = await assertRejects(() => persister.updateBatch([], auth), RetryableError);
  assertEquals(error.message, 'new row violates row-level security policy');
});

Deno.test('other persister errors pass through unchanged', async () => {
  const fatal = new FatalOperationError('CHECK_VIOLATION', 'bad value');
  assertEquals(await assertRejects(() => permissionErrorsRetryable(failing(fatal)).updateBatch([], auth)), fatal);
  await permissionErrorsRetryable({ ping: () => Promise.resolve(), updateBatch: () => Promise.resolve() }).updateBatch([], auth);
});

Deno.test('ping passes through to the wrapped persister', async () => {
  let pinged = 0;
  const persister = permissionErrorsRetryable({
    ping: () => Promise.resolve(void pinged++),
    updateBatch: () => Promise.resolve()
  });
  await persister.ping();
  assertEquals(pinged, 1);
});
