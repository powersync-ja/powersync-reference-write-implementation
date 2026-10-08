import { createLocalJWKSet, createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import {
  AuthConfigurationError, InvalidTokenError, KeyFetchError,
} from './types.js';
import type { KeySource, ResolvedAuthConfig, TokenVerifier } from './types.js';
import { ASYMMETRIC_ALGORITHMS, httpTrust, keyUrl, nonempty, publicKey, strings } from './validation.js';

export interface VerifierOptions {
  /** Optional transport injection, principally for deterministic tests. Must be trusted. */
  fetch?: typeof globalThis.fetch;
  timeoutDuration?: number;
  cooldownDuration?: number;
  cacheMaxAge?: number;
}

/** Validate and snapshot even direct factory calls; later caller mutations cannot alter trust. */
function snapshot(input: ResolvedAuthConfig): ResolvedAuthConfig {
  try {
    if (!['generic', 'supabase'].includes(input.provider) || !nonempty(input.issuer) ||
        !strings(input.audience) || !input.audience.length || !strings(input.algorithms) || !input.algorithms.length ||
        input.algorithms.some(alg => !(ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg)) ||
        typeof input.allowLocalHttp !== 'boolean' || !Array.isArray(input.sources) || !input.sources.length ||
        !Array.isArray(input.insecureHttpHosts) || (input.insecureHttpHosts.length && !strings(input.insecureHttpHosts))) throw new Error();
    const trust = httpTrust(input.allowLocalHttp, input.insecureHttpHosts);
    const sources: KeySource[] = input.sources.map(source => {
      if (source.kind === 'remote') return { kind: 'remote', uri: keyUrl(source.uri, trust).href };
      if (source.kind === 'inline' && Array.isArray(source.jwks.keys) && source.jwks.keys.length) {
        return { kind: 'inline', jwks: { keys: source.jwks.keys.map(publicKey) } };
      }
      throw new Error();
    });
    return { ...input, sources, audience: [...input.audience], algorithms: [...input.algorithms], insecureHttpHosts: [...input.insecureHttpHosts] };
  } catch { throw new AuthConfigurationError(); }
}

function resolver(source: KeySource, options: VerifierOptions): JWTVerifyGetKey {
  if (source.kind === 'inline') return createLocalJWKSet(source.jwks);
  const remote = createRemoteJWKSet(new URL(source.uri), {
    ...(options.fetch ? { [customFetch]: options.fetch } : {}),
    timeoutDuration: options.timeoutDuration ?? 5000,
    cooldownDuration: options.cooldownDuration ?? 30000,
    cacheMaxAge: options.cacheMaxAge ?? 600000,
  });
  return async (header, token) => {
    try { return await remote(header, token); }
    catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys || error instanceof errors.JOSENotSupported) throw error;
      throw new KeyFetchError();
    }
  };
}

/** Shared signature/claim checks used by every sibling approach. */
function verifierFor(config: ResolvedAuthConfig, options: VerifierOptions): TokenVerifier {
  for (const field of ['timeoutDuration', 'cooldownDuration', 'cacheMaxAge'] as const) {
    const value = options[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new AuthConfigurationError('Invalid JWKS timing option.');
  }
  // Inline first avoids a network request for a known local kid. All sources share one policy.
  const ordered = [...config.sources].sort((a, b) => Number(a.kind === 'remote') - Number(b.kind === 'remote'));
  const resolvers = ordered.map(source => resolver(source, options));
  const getKey: JWTVerifyGetKey = async (header, token) => {
    for (const get of resolvers) {
      try { return await get(header, token); }
      catch (error) {
        // Continue only on key absence, never on a bad signature, outage, or ambiguous match.
        if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
      }
    }
    throw new errors.JWKSNoMatchingKey();
  };
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          algorithms: config.algorithms,
          issuer: config.issuer,
          audience: config.audience,
          requiredClaims: ['exp', 'sub', 'iss', 'aud'],
        });
        if (!nonempty(payload.sub)) throw new InvalidTokenError();
        return { sub: payload.sub, claims: payload };
      } catch (error) {
        if (error instanceof KeyFetchError) throw error;
        throw new InvalidTokenError();
      }
    },
  };
}

/** Sibling 1: Supabase-specific discovery/defaults, common JWT cryptography. */
export function createSupabaseVerifier(input: ResolvedAuthConfig, options: VerifierOptions = {}): TokenVerifier {
  const config = snapshot(input);
  if (config.provider !== 'supabase') throw new AuthConfigurationError('Expected resolved Supabase configuration.');
  return verifierFor(config, options);
}

/** Sibling 2: one generic remotely hosted public JWKS. */
export function createRemoteJwksVerifier(input: ResolvedAuthConfig, options: VerifierOptions = {}): TokenVerifier {
  const config = snapshot(input);
  if (config.provider !== 'generic' || config.sources.length !== 1 || config.sources[0]?.kind !== 'remote') throw new AuthConfigurationError('Expected one generic remote JWKS source.');
  return verifierFor(config, options);
}

/** Sibling 3: generic public keys captured in the CLI export. Re-export on rotation. */
export function createInlinePublicKeyVerifier(input: ResolvedAuthConfig): TokenVerifier {
  const config = snapshot(input);
  if (config.provider !== 'generic' || config.sources.length !== 1 || config.sources[0]?.kind !== 'inline') throw new AuthConfigurationError('Expected one generic inline key source.');
  return verifierFor(config, {});
}

/** Explicit composition of sources under ONE issuer/audience policy, not provider fallback. */
export function createCombinedVerifier(input: ResolvedAuthConfig, options: VerifierOptions = {}): TokenVerifier {
  const config = snapshot(input);
  if (config.sources.length < 2) throw new AuthConfigurationError('Expected multiple explicit key sources.');
  return verifierFor(config, options);
}

/** Startup gate: incoming token contents never decide the provider or trusted URLs. */
export function createTokenVerifier(input: ResolvedAuthConfig, options: VerifierOptions = {}): TokenVerifier {
  const config = snapshot(input);
  if (config.provider === 'supabase') return createSupabaseVerifier(config, options);
  if (config.sources.length > 1) return createCombinedVerifier(config, options);
  return config.sources[0]?.kind === 'remote'
    ? createRemoteJwksVerifier(config, options)
    : createInlinePublicKeyVerifier(config);
}
