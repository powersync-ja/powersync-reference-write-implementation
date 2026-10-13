import express from 'express';
import { dataRouter } from './data.ts';

const router = express.Router();

// Authentication is applied in app.ts, before body parsing and validation
router.use('/data', dataRouter);

export { router as apiRouter };
