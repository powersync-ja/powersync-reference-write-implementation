import { assertEquals } from '@std/assert';
import { admin, applyTestSchema, FUNCTION_URL, listRow, signUp } from './helpers.ts';

/**
 * Runs the unchanged single-file example connector against the function. Only its BACKEND_URL
 * and AUTH_TOKEN constants are replaced.
 */
Deno.test({
  name: 'example connector uploads through the function URL',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await applyTestSchema();
    const user = await signUp('connector');
    const source = await Deno.readTextFile(new URL('../../../example-client/src/PowersyncConnector.singlefile.ts', import.meta.url));
    const configured = source
      .replace(/^const BACKEND_URL = .*$/m, `const BACKEND_URL = ${JSON.stringify(FUNCTION_URL)};`)
      .replace(/^const AUTH_TOKEN = .*$/m, `const AUTH_TOKEN = ${JSON.stringify(user.token)};`);
    const path = await Deno.makeTempFile({ suffix: '.ts' });
    await Deno.writeTextFile(path, configured);

    const storage = new Map<string, string>();
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) }
    });
    const { PowersyncConnector } = await import(`file://${path}`);

    const list = crypto.randomUUID();
    let completed = 0;
    const database = {
      async *getCrudTransactions() {
        yield {
          transactionId: 1,
          crud: [{ op: 'PUT', table: 'lists', id: list, opData: { name: 'From connector' } }],
          complete: async () => {
            completed++;
          }
        };
      }
    };

    try {
      await new PowersyncConnector().uploadData(database);
      assertEquals(completed, 1);
      assertEquals(await listRow(list), { name: 'From connector', owner_id: user.id });
    } finally {
      await Deno.remove(path);
      await admin.end();
    }
  }
});
