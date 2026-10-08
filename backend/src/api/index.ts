import express from 'express';
import { dataRouter } from './data.js';
import { requireAuth } from '../auth/middleware.js';
import { verifier } from '../auth/verifier.js';

const router = express.Router();

// Writes require a valid bearer token; see src/auth/verifier.ts to swap providers
router.use('/data', requireAuth(verifier), dataRouter);

export { router as apiRouter };
