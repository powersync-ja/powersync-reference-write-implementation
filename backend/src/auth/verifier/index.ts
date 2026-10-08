export { resolvePowerSyncAuth } from './resolve.js';
export { resolveSelfHostedAuth } from './self-hosted.js';
export { supplementsFromEnv } from './env.js';
export {
  createTokenVerifier, createSupabaseVerifier, createRemoteJwksVerifier,
  createInlinePublicKeyVerifier, createCombinedVerifier,
} from './verifiers.js';
export type { VerifierOptions } from './verifiers.js';
export {
  AuthConfigurationError, InvalidTokenError, KeyFetchError,
} from './types.js';
export type {
  TokenVerifier, AuthSupplements, ResolvedAuthConfig, ResolutionResult,
  Diagnostic, KeySource,
} from './types.js';
