import type { components, operations } from './generated/api.ts';
import type { EntryMapper } from './mapping/types.ts';

export type CrudEntry = components['schemas']['CrudEntry'];
export type OpType = CrudEntry['op'];

export type TransactionResult = components['schemas']['TransactionResponse'];

/** Extract the JSON request body type for a given operation */
export type OpBody<Op extends keyof operations> = operations[Op] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** Extract the JSON 200 response body type for a given operation */
export type OpResponse<Op extends keyof operations> = operations[Op] extends {
  responses: { 200: { content: { 'application/json': infer R } } };
}
  ? R
  : never;

/** Extract the query parameters type for a given operation */
export type OpQuery<Op extends keyof operations> = operations[Op] extends { parameters: { query?: infer Q } }
  ? Q
  : never;

/** Verified caller identity, independent of runtime and token provider. */
export interface AuthContext {
  /** The verified subject (user id) from the token, used instead of any identity from the request body. */
  sub: string;
  claims: Record<string, unknown>;
}

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

export interface Persister {
  updateBatch: (batch: CrudEntry[], auth: AuthContext) => Promise<void>;
}

export type PersisterFactory = (uri: string, mapper?: EntryMapper) => Persister | Promise<Persister>;
