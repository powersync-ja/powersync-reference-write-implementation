import type { components, operations } from './generated/api.js';
import type { EntryMapper } from './mapping/types.js';
import type { AuthContext } from './auth/types.js';

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

export interface Persister {
  updateBatch: (batch: CrudEntry[], auth: AuthContext) => Promise<void>;
}

export type PersisterFactory = (uri: string, mapper?: EntryMapper) => Persister | Promise<Persister>;
