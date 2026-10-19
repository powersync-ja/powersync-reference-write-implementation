import { readFile } from 'node:fs/promises';
import {
  AuthConfigurationError, createTokenVerifier, resolvePowerSyncAuth, resolveSelfHostedAuth
} from '../../../shared/src/auth/verifier/index.ts';
import { authModeFromEnv, supplementsFromEnv } from '../../../shared/src/auth/verifier/env.ts';
import type { ResolutionResult } from '../../../shared/src/auth/verifier/types.ts';
import type { TokenVerifier } from './types.ts';

// What the PowerSync export cannot tell the verifier comes from AUTH_* environment variables
// (parsed in ./verifier/env.ts), not from edits to this file. See docs/auth/setup.md for what each one is for.

// AUTH_MODE=env configures the verifier from AUTH_* variables alone: no config file is read.
function resolveFromEnv(): ResolutionResult {
  const supplements = supplementsFromEnv();
  const { jwksUri, ...rest } = supplements;
  if (!jwksUri && !supplements.jwksUriOverride) {
    throw new AuthConfigurationError(
      'AUTH_MODE=env requires AUTH_JWKS_URI (your provider\'s key endpoint), ' +
        'AUTH_ISSUER and AUTH_AUDIENCE. See docs/auth/setup.md.'
    );
  }
  // The self-hosted resolver takes the key endpoint from the service config, so state it there.
  return resolveSelfHostedAuth({ client_auth: jwksUri ? { jwks_uri: jwksUri } : {} }, rest);
}

async function loadVerifier(): Promise<TokenVerifier> {
  const result = authModeFromEnv() === 'env' ? resolveFromEnv() : await resolveFromFile();
  if (result.status !== 'ready') {
    // Diagnostics name the offending field; they never echo configuration values.
    throw new AuthConfigurationError(
      'Invalid PowerSync auth configuration. Check POWERSYNC_CONFIG_PATH and the AUTH_* settings ' +
        'in the environment (.env / .env.local). See docs/auth/setup.md.\n\n' +
        result.diagnostics.map((d) => `${d.field}: ${d.message}`).join('\n')
    );
  }
  for (const diagnostic of result.diagnostics) console.warn(diagnostic.message);
  return createTokenVerifier(result.config);
}

async function resolveFromFile(): Promise<ResolutionResult> {
  // The default is relative to this module; an override is absolute or relative to process cwd.
  const dumpPath = process.env.POWERSYNC_CONFIG_PATH ?? new URL('../../config/powersync-config.json', import.meta.url);
  let contents: string;
  try {
    contents = await readFile(dumpPath, 'utf8');
  } catch {
    throw new AuthConfigurationError(
      'Cannot read the PowerSync auth configuration. Export it to backend/standalone/config/powersync-config.json, ' +
        'set POWERSYNC_CONFIG_PATH in .env to a readable JSON file, or set AUTH_MODE=env. ' +
        'For Docker, mount the file read-only. See docs/auth/setup.md.'
    );
  }

  let dump: unknown;
  try {
    dump = JSON.parse(contents);
  } catch {
    throw new AuthConfigurationError(
      'Invalid JSON in the PowerSync auth configuration. Re-export the complete CLI JSON response ' +
        'and check POWERSYNC_CONFIG_PATH in .env. See docs/auth/setup.md.'
    );
  }

  // The shape tells the two apart: a Cloud export wraps the service config in `config`, a
  // self-hosted service config has `client_auth` at the top level.
  const top = typeof dump === 'object' && dump !== null ? dump as Record<string, unknown> : {};
  if ('config' in top) return resolvePowerSyncAuth(dump, supplementsFromEnv());
  if ('client_auth' in top) return resolveSelfHostedAuth(dump, supplementsFromEnv());
  throw new AuthConfigurationError(
    'Unrecognized PowerSync auth configuration. Expected a Cloud export (a top-level "config" object) ' +
      'or a self-hosted service configuration (a top-level "client_auth" object). ' +
      'Check POWERSYNC_CONFIG_PATH in .env. See docs/auth/setup.md.'
  );
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
