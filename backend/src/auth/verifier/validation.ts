import type { JWK } from 'jose';
import { AuthConfigurationError } from './types.js';

export const ASYMMETRIC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512', 'EdDSA',
] as const;

export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}

/**
 * The set of hostnames that may serve keys over plain HTTP. Everything outside it requires HTTPS.
 * Loopback is a named opt-in; other hosts must be listed one by one, never by pattern.
 */
export function httpTrust(allowLocalHttp: boolean, insecureHttpHosts: readonly string[] = []): Set<string> {
  return new Set([...(allowLocalHttp ? LOOPBACK_HOSTS : []), ...insecureHttpHosts]);
}

export function keyUrl(value: string, trust: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthConfigurationError('Invalid JWKS URL.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && trust.has(url.hostname))) ||
      url.username || url.password || url.hash || url.search) {
    throw new AuthConfigurationError('JWKS URLs require HTTPS without credentials, query, or fragment; plain HTTP needs an explicit per-host opt-in.');
  }
  return url;
}

/** Copy only public signature-verification fields, never arbitrary JWK metadata. */
export function publicKey(value: unknown): JWK {
  const key = object(value);
  if (!key || !['RSA', 'EC', 'OKP'].includes(String(key.kty)) ||
      ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(field => field in key)) {
    throw new AuthConfigurationError('Only asymmetric public keys are supported.');
  }
  if (key.use !== undefined && key.use !== 'sig') throw new AuthConfigurationError('Expected a signature key.');
  if (key.key_ops !== undefined && (!strings(key.key_ops) || !key.key_ops.includes('verify') || key.key_ops.some(op => op !== 'verify'))) {
    throw new AuthConfigurationError('Expected public verification key operations.');
  }
  if (key.alg !== undefined && !(ASYMMETRIC_ALGORITHMS as readonly unknown[]).includes(key.alg)) {
    throw new AuthConfigurationError('Unsupported key algorithm.');
  }
  const required = key.kty === 'RSA' ? ['n', 'e'] : key.kty === 'EC' ? ['crv', 'x', 'y'] : ['crv', 'x'];
  if (!required.every(field => nonempty(key[field]))) throw new AuthConfigurationError('Incomplete public key.');
  if (key.kty === 'EC' && !['P-256', 'P-384', 'P-521'].includes(String(key.crv))) throw new AuthConfigurationError('Unsupported EC curve.');
  if (key.kty === 'OKP' && key.crv !== 'Ed25519') throw new AuthConfigurationError('Unsupported OKP curve.');
  if (key.kid !== undefined && !nonempty(key.kid)) throw new AuthConfigurationError('Invalid key identifier.');
  const result: Record<string, unknown> = {};
  for (const field of ['kty', 'kid', 'alg', 'use', 'key_ops', ...required]) {
    if (key[field] !== undefined) result[field] = key[field];
  }
  return result as JWK;
}
