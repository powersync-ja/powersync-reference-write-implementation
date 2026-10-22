import { createPostgresPersister } from '@powersync/write-core/persistence/postgres/postgres-persistence.ts';
import { createTransactionProcessor, type TransactionProcessor } from '@powersync/write-core/write/processor.ts';
import { validateBatchBody } from '@powersync/write-core/write/validate-batch.ts';
import type { AuthContext } from '@powersync/write-core/types.ts';
import { authorizer } from './authorizer.ts';
import { batchOnFatalError, pool, readConfig } from './config.ts';
import { fatalErrorHandler } from './fatal-error-handler.ts';
import { mapper } from './mapper.ts';
import { asAuthenticatedUser, permissionErrorsRetryable } from './rls.ts';

/** Matches /<function-name>/api/data, so connectors use the function URL as their backend URL. */
const DATA_PATH = /^\/[^/]+\/api\/data\/?$/;

const message = (status: number, text: string) => Response.json({ message: text }, { status });

let processor: TransactionProcessor | undefined;
const getProcessor = (): TransactionProcessor => {
  if (!processor) {
    const persister = permissionErrorsRetryable(
      createPostgresPersister(readConfig().databaseUrl, mapper, {
        pool,
        initializeTransaction: asAuthenticatedUser
      })
    );
    processor = createTransactionProcessor({
      persister: () => persister,
      authorizer,
      fatalErrorHandler,
      batchOnFatalError: () => batchOnFatalError,
      awaitDeadLetter: true
    });
  }
  return processor;
};

/**
 * Checks the claims this endpoint requires beyond what the auth middleware verifies (signature,
 * audience, and an exp that has not passed). The middleware does not require exp, a subject
 * that is non-empty, or a role. Returns the identity for an ordinary signed-in user, or null.
 */
export function userIdentity(claims: Record<string, unknown>): AuthContext | null {
  const { sub, exp, role } = claims;
  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof exp !== 'number') return null;
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
