export { resolvePowerSyncAuth } from './resolve.ts';
export { resolveSelfHostedAuth } from './self-hosted.ts';
export { supplementsFromEnv } from './env.ts';
export {
  createTokenVerifier, createSupabaseVerifier, createRemoteJwksVerifier,
  createInlinePublicKeyVerifier, createCombinedVerifier,
} from './verifiers.ts';
export type { VerifierOptions } from './verifiers.ts';
export {
  AuthConfigurationError, InvalidTokenError, KeyFetchError,
} from './types.ts';
export type {
  TokenVerifier, AuthSupplements, ResolvedAuthConfig, ResolutionResult,
  Diagnostic, KeySource,
} from './types.ts';
