import { assertEquals } from '@std/assert';
import { fromFileUrl, relative } from '@std/path';

const FUNCTION_DIR = new URL('../../functions/powersync-write/', import.meta.url);
const REPO = fromFileUrl(new URL('../../../', import.meta.url));

/**
 * The deployed function must not pull in other databases, Express, or Node configuration. Local
 * modules are listed exactly, so a new import has to be added here deliberately.
 */
Deno.test('function import graph contains only the edge modules', async () => {
  const output = await new Deno.Command('deno', { args: ['info', '--json', 'index.ts'], cwd: FUNCTION_DIR, stdout: 'piped' }).output();
  const info = JSON.parse(new TextDecoder().decode(output.stdout));
  const modules: { kind: string; specifier: string; npmPackage?: string }[] = info.modules;

  const local = modules
    .filter((m) => m.kind === 'esm')
    .map((m) => relative(REPO, fromFileUrl(m.specifier)))
    .sort();
  assertEquals(local, [
    'backend/src/auth/authorizer.ts',
    'backend/src/auth/types.ts',
    'backend/src/errors.ts',
    'backend/src/generated/api.ts',
    'backend/src/generated/transaction-batch-validator.ts',
    'backend/src/mapping/default.ts',
    'backend/src/mapping/types.ts',
    'backend/src/persistence/identifiers.ts',
    'backend/src/persistence/postgres/postgres-errors.ts',
    'backend/src/persistence/postgres/postgres-persistence.ts',
    'backend/src/types.ts',
    'backend/src/write/dead-letter.ts',
    'backend/src/write/processor.ts',
    'backend/src/write/validate-batch.ts',
    'supabase/functions/powersync-write/authorizer.ts',
    'supabase/functions/powersync-write/config.ts',
    'supabase/functions/powersync-write/fatal-error-handler.ts',
    'supabase/functions/powersync-write/handler.ts',
    'supabase/functions/powersync-write/index.ts',
    'supabase/functions/powersync-write/mapper.ts',
    'supabase/functions/powersync-write/rls.ts'
  ]);

  const npmRoots = modules
    .filter((m) => m.kind === 'npm')
    .map((m) => m.specifier)
    .sort();
  assertEquals(npmRoots, [
    'npm:/@supabase/middleware@1.0.0',
    'npm:/@supabase/middleware@1.0.0/cors',
    'npm:/@supabase/server@1.9.2/middleware/required-claims',
    'npm:/@types/pg@8.20.0',
    'npm:/pg@8.13.0'
  ]);

  // Resolved packages include peers that are downloaded but never imported (supabase-js).
  const forbidden = /^(mongodb|mysql2|mssql|tedious|express|express-openapi-validator|dotenv|winston)@/;
  assertEquals(Object.keys(info.npmPackages).filter((name) => forbidden.test(name)), []);
});
