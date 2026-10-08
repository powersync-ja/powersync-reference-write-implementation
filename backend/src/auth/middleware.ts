import type { Request, Response, NextFunction } from 'express';
import type { TokenVerifier } from './types.js';

/**
 * Gate: require a valid bearer token, verified by the given TokenVerifier.
 *
 * - no/malformed Authorization header -> 401 { message }
 * - verifier.verify throws            -> 401 { message }
 * - success -> req.auth = { sub, claims }; next()
 */
export function requireAuth(verifier: TokenVerifier) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).send({ message: 'Missing bearer token' });
    }

    try {
      req.auth = await verifier.verify(header.slice('Bearer '.length));
      next();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(`Token verification failed: ${detail}`);
      res.status(401).send({ message: 'Invalid token' });
    }
  };
}
