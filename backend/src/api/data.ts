import config from '../../config.ts';
import { fatalErrorHandler } from '../fatal-error-handler.ts';
import express, { type Request, type Response } from 'express';
import { getPersister } from '../persistence/persister.ts';
import { authorizer } from '../auth/authorizer.ts';
import { createTransactionProcessor } from '../write/processor.ts';
import type { OpBody, OpResponse } from '../types.ts';

const router = express.Router();

const processTransactions = createTransactionProcessor({
  persister: getPersister,
  authorizer,
  fatalErrorHandler,
  batchOnFatalError: () => config.batchOnFatalError
});

/** Applies uploaded transactions in order; see createTransactionProcessor for batch semantics. */
router.post(
  '/',
  async (
    req: Request<{}, OpResponse<'postTransactionBatch'>, OpBody<'postTransactionBatch'>>,
    res: Response<OpResponse<'postTransactionBatch'>>
  ) => {
    // Verified identity from the token
    console.log(`Write authenticated as ${req.auth?.sub}`);

    const results = await processTransactions(req.body.transactions, req.auth!);
    res.status(200).send({ results });
  }
);

export { router as dataRouter };
