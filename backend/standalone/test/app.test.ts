import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Importing the app and validating requests must not need a developer's config export.
vi.hoisted(() => vi.stubEnv('POWERSYNC_CONFIG_PATH', '/missing-auth-config-for-app-tests.json'));
afterAll(() => vi.unstubAllEnvs());

// Accepts one known token so requests can get past authentication to request validation.
vi.mock('../src/auth/verifier.ts', () => ({
  verifier: {
    async verify(token: string) {
      if (token !== 'valid-token') throw new Error('invalid token');
      return { sub: 'user-1', claims: {} };
    }
  }
}));

const persister = vi.hoisted(() => ({ ping: vi.fn() }));
vi.mock('../src/persistence/persister.ts', () => ({ getPersister: async () => persister }));

import app from '../app.ts';

/**
 * Regression tests for OpenAPI contract loading over HTTP.
 * The validator loads the spec on the first request, before checking route exemptions.
 * An unreadable spec therefore breaks both the root route and request validation.
 */
describe('the assembled application', () => {
  it('serves its root route when the database answers', async () => {
    persister.ping.mockResolvedValue(undefined);

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(persister.ping).toHaveBeenCalled();
  });

  it('reports the root route unhealthy when the database does not answer', async () => {
    persister.ping.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const response = await request(app).get('/');

    expect(response.status).toBe(503);
  });

  it('rejects a request that violates the OpenAPI contract', async () => {
    // An authenticated request reaches validation; the empty batch violates minItems.
    const response = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer valid-token')
      .send({ transactions: [] });

    expect(response.status).toBe(400);
  });

  it('authenticates before validating the request body', async () => {
    const invalidToken = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ transactions: [] });
    const missingToken = await request(app).post('/api/data').send({ transactions: [] });
    const malformedJson = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer not-a-real-token')
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(invalidToken.status).toBe(401);
    expect(missingToken.status).toBe(401);
    expect(malformedJson.status).toBe(401);
  });

  it('answers CORS preflight without a token', async () => {
    const response = await request(app).options('/api/data');

    expect(response.status).toBe(200);
  });
});
