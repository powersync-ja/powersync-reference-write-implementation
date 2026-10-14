import type { Authorizer } from '../../../backend/src/types.ts';

/**
 * Application checks that run before each transaction is written. Row-level security and
 * grants already apply to every write as the authenticated user, so this allows everything
 * by default. Return false to reject a transaction; see docs/auth/authorization.md.
 */
export const authorizer: Authorizer = {
  authorize: (_crud, _auth) => true
};
