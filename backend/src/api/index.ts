import express from 'express';
import { dataRouter } from './data.ts';
import { requireAuth } from '../auth/middleware.ts';
import { verifier } from '../auth/verifier.ts';

const router = express.Router();

// Writes require a valid bearer token; see src/auth/verifier.ts to swap providers
router.use('/data', requireAuth(verifier), dataRouter);

export { router as apiRouter };
