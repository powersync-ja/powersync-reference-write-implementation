import { AuthConfigurationError } from './types.js';
import type { AuthSupplements } from './types.js';

/**
 * Environment variable for each supplement. Set them in the root `.env` (shared defaults) or
 * `.env.local` (this machine) for Docker Compose, or in `backend/.env` when running on the host.
 * Unset or blank means "not supplied". List values are comma-separated.
 *
 * | Variable | Supplement |
 * | --- | --- |
 * | `AUTH_ISSUER` | `issuer` |
 * | `AUTH_AUDIENCE` | `audience` (list) |
 * | `AUTH_INSTANCE_URL` | `instanceUrl` |
 * | `AUTH_SUPABASE_URL` | `supabaseUrl` |
 * | `AUTH_PROVIDER` | `provider`: `supabase` or `generic` |
 * | `AUTH_JWKS_URI` | `jwksUri` |
 * | `AUTH_JWKS_URI_OVERRIDE` | `jwksUriOverride` (list) |
 * | `AUTH_ALGORITHMS` | `algorithms` (list) |
 * | `AUTH_ALLOW_LOCAL_HTTP` | `allowLocalHttp`: `true` or `false` |
 * | `AUTH_ALLOW_INSECURE_HTTP_HOSTS` | `allowInsecureHttpHosts` (list) |
 */
export function supplementsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSupplements {
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const list = (name: string): string[] | undefined => {
    const values = (text(name) ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length ? values : undefined;
  };
  const flag = (name: string): boolean | undefined => {
    const value = text(name)?.toLowerCase();
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new AuthConfigurationError(`Set ${name} to "true" or "false" (got "${env[name]}").`);
  };
  const provider = text('AUTH_PROVIDER');
  if (provider !== undefined && provider !== 'supabase' && provider !== 'generic') {
    throw new AuthConfigurationError(`Set AUTH_PROVIDER to "supabase" or "generic" (got "${provider}").`);
  }

  const candidates: AuthSupplements = {
    issuer: text('AUTH_ISSUER'),
    audience: list('AUTH_AUDIENCE'),
    instanceUrl: text('AUTH_INSTANCE_URL'),
    supabaseUrl: text('AUTH_SUPABASE_URL'),
    provider: provider as AuthSupplements['provider'],
    jwksUri: text('AUTH_JWKS_URI'),
    jwksUriOverride: list('AUTH_JWKS_URI_OVERRIDE'),
    algorithms: list('AUTH_ALGORITHMS'),
    allowLocalHttp: flag('AUTH_ALLOW_LOCAL_HTTP'),
    allowInsecureHttpHosts: list('AUTH_ALLOW_INSECURE_HTTP_HOSTS')
  };
  // The resolver treats a missing key and an undefined one differently in a few places; omit unset keys.
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined)) as AuthSupplements;
}
