import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as OpenApiValidator from 'express-openapi-validator';
import { apiRouter } from './src/api/index.ts';
import { requireAuth } from './src/auth/middleware.ts';
import { verifier } from './src/auth/verifier.ts';
import logRequest from './src/middleware/logger.ts';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(logRequest);

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Writes require a valid bearer token; see src/auth/verifier.ts to swap providers.
// Auth runs before body parsing and validation, so unauthenticated callers only ever see a 401.
app.use('/api/data', requireAuth(verifier));
app.use(express.json());

app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(__dirname, 'powersync-reference-write-api.openapi.yaml'),
    validateRequests: true,
    validateResponses: false,
    // The liveness probe is outside the OpenAPI contract.
    ignorePaths: /^\/$/
  })
);

app.get('/', (_req: Request, res: Response) => {
  res.status(200).send({ message: 'backend' });
});

app.use('/api', apiRouter);

const errorHandler = (err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status || 500).send({ message: err.message });
};
app.use(errorHandler);

export default app;
