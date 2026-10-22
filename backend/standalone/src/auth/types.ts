import type { AuthContext } from '../../../shared/src/types.ts';

/**
 * Verifies a bearer token and returns a normalized identity.
 * Each implementation handles its provider's keys, algorithms, and claims.
 */
export interface TokenVerifier {
  /** Resolves the verified identity, or throws if the token is invalid. */
  verify(token: string): Promise<AuthContext>;
}
