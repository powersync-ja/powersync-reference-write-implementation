import type { AuthContext } from './types.ts';

// Node-only: kept out of types.ts so runtime-independent code can import it without Express.
declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after successful verification. */
      auth?: AuthContext;
    }
  }
}
