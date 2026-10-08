/**
 * Verifies a bearer token and returns a normalized identity.
 * Each implementation handles its provider's keys, algorithms, and claims.
 */
export interface TokenVerifier {
  /** Resolves the verified identity, or throws if the token is invalid. */
  verify(token: string): Promise<AuthContext>;
}

export interface AuthContext {
  /** The verified subject (user id) from the token, used instead of any identity from the request body. */
  sub: string;
  claims: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after successful verification. */
      auth?: AuthContext;
    }
  }
}
