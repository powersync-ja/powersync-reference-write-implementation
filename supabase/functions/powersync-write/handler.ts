import { assertSafeTransaction } from '../../../backend/src/persistence/identifiers.ts';
import { createPostgresPersister } from '../../../backend/src/persistence/postgres/postgres-persistence.ts';
import { createTransactionProcessor, type TransactionProcessor } from '../../../backend/src/write/processor.ts';
import { validateBatchBody } from '../../../backend/src/write/validate-batch.ts';
import type { AuthContext } from '../../../backend/src/auth/types.ts';
import { authorizer } from './authorizer.ts';
import { batchOnFatalError, pool, readConfig } from './config.ts';
import { fatalErrorHandler } from './fatal-error-handler.ts';
import { mapper } from './mapper.ts';
import { asAuthenticatedUser } from './rls.ts';

/** Matches /<function-name>/api/data, so connectors use the function URL as their backend URL. */
const DATA_PATH = /^\/[^/]+\/api\/data\/?$/;

const message = (status: number, text: string) => Response.json({ message: text }, { status });

let processor: TransactionProcessor | undefined;
const getProcessor = (): TransactionProcessor => {
  if (!processor) {
    const persister = createPostgresPersister(readConfig().databaseUrl, mapper, {
      pool,
      initializeTransaction: asAuthenticatedUser
    });
    // Rejects unsafe client table and column names before any database work, like the Express
    // backend's persister factories. See docs/schema-mapping.md#identifier-validation.
    const validated = {
      updateBatch: async (...args: Parameters<typeof persister.updateBatch>) => {
        assertSafeTransaction(args[0]);
        return persister.updateBatch(...args);
      }
    };
    processor = createTransactionProcessor({
      persister: () => validated,
      authorizer,
      fatalErrorHandler,
      batchOnFatalError: () => batchOnFatalError,
      awaitDeadLetter: true
    });
  }
  return processor;
};

/**
 * Checks the claims this endpoint requires beyond signature and audience, which the
 * auth middleware has verified. Returns the identity for an ordinary signed-in user, or null.
 */
export function userIdentity(claims: Record<string, unknown>): AuthContext | null {
  const { sub, exp, role } = claims;
  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;
  if (role !== 'authenticated') return null;
  return { sub, claims };
}

/** Handles a request whose bearer token has been verified. */
export async function handleWrite(req: Request, claims: Record<string, unknown>): Promise<Response> {
  if (!DATA_PATH.test(new URL(req.url).pathname)) return message(404, 'Not found');
  if (req.method !== 'POST') return message(405, 'Method not allowed');

  const auth = userIdentity(claims);
  if (!auth) return message(401, 'A signed-in user token is required');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return message(400, 'Request body must be JSON');
  }
  const validated = validateBatchBody(body);
  if (!validated.valid) return message(400, validated.message);

  const results = await getProcessor()(validated.transactions, auth);
  return Response.json({ results });
}
