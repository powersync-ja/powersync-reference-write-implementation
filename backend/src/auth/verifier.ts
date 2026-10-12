import { readFile } from 'node:fs/promises';
import { AuthConfigurationError, createTokenVerifier, resolvePowerSyncAuth } from './verifier/index.js';
import { supplementsFromEnv } from './verifier/env.js';
import type { TokenVerifier } from './types.js';

// What the PowerSync export cannot tell the verifier comes from AUTH_* environment variables
// (parsed in ./verifier/env.ts), not from edits to this file. See SETUP.md for what each one is for.

async function loadVerifier(): Promise<TokenVerifier> {
  // The default is relative to this module; an override is absolute or relative to process cwd.
  const dumpPath = process.env.POWERSYNC_CONFIG_PATH ?? new URL('../../powersync-config.json', import.meta.url);
  let contents: string;
  try {
    contents = await readFile(dumpPath, 'utf8');
  } catch {
    throw new AuthConfigurationError(
      'Cannot read the PowerSync auth configuration. Export it to backend/powersync-config.json ' +
        'or set POWERSYNC_CONFIG_PATH in .env to a readable JSON file. ' +
        'For Docker, mount the file read-only. See backend/src/auth/SETUP.md.'
    );
  }

  let dump: unknown;
  try {
    dump = JSON.parse(contents);
  } catch {
    throw new AuthConfigurationError(
      'Invalid JSON in the PowerSync auth configuration. Re-export the complete CLI JSON response ' +
        'and check POWERSYNC_CONFIG_PATH in .env. See backend/src/auth/SETUP.md.'
    );
  }

  const result = resolvePowerSyncAuth(dump, supplementsFromEnv());
  if (result.status !== 'ready') {
    // Diagnostics name the offending field; they never echo configuration values.
    throw new AuthConfigurationError(
      'Invalid PowerSync auth configuration. Check POWERSYNC_CONFIG_PATH and the AUTH_* settings ' +
        'in the environment (.env / .env.local). See backend/src/auth/SETUP.md.\n\n' +
        result.diagnostics.map((d) => `${d.field}: ${d.message}`).join('\n')
    );
  }
  for (const diagnostic of result.diagnostics) console.warn(diagnostic.message);
  return createTokenVerifier(result.config);
}

// Startup awaits this before listening. Cache the promise so concurrent callers share one JWKS
// cache; configuration changes (including failed initialization) require a process restart.
let initialized: Promise<TokenVerifier> | undefined;
export function initializeVerifier(): Promise<TokenVerifier> {
  return (initialized ??= loadVerifier());
}

// Importing the app does not load auth configuration. Startup initializes the verifier;
// direct app usage initializes it on the first verification request.
export const verifier: TokenVerifier = {
  async verify(token) {
    return (await initializeVerifier()).verify(token);
  }
};
