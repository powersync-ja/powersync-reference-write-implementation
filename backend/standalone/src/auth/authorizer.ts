import type { Authorizer } from '../../../shared/src/types.ts';

/**
 * Allows all authenticated writes. Replace this implementation with your application's
 * authorization checks. See docs/auth/authorization.md.
 */
export const authorizer: Authorizer = {
  async authorize(_crud, _auth) {
    console.error(
      'Authorization is not configured. All authenticated writes are allowed. ' +
        'Configure backend/standalone/src/auth/authorizer.ts; see docs/auth/authorization.md.'
    );
    return true;
  }
};
