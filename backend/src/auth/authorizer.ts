import type { CrudEntry } from '../types.js';
import type { AuthContext } from './types.js';

/**
 * Checks whether an authenticated caller may apply a transaction.
 * Called before persistence with the ordered CRUD operations and verified identity.
 * Existing rows are not available through this interface. Check row ownership inside
 * the persister's database transaction.
 *
 * Return false to reject the transaction with a fatal error.
 */
export interface Authorizer {
  authorize(crud: CrudEntry[], auth: AuthContext): boolean | Promise<boolean>;
}

/**
 * Allows all authenticated writes. Replace this implementation with your application's
 * authorization checks. See docs/authorization.md.
 */
export const authorizer: Authorizer = {
  async authorize(_crud, _auth) {
    console.error(
      'Authorization is not configured. All authenticated writes are allowed. ' +
        'Configure backend/src/auth/authorizer.ts; see docs/authorization.md.'
    );
    return true;
  }
};
