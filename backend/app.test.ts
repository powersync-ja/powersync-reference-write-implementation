import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Importing the app and validating requests must not need a developer's config export.
vi.hoisted(() => vi.stubEnv('POWERSYNC_CONFIG_PATH', '/missing-auth-config-for-app-tests.json'));
afterAll(() => vi.unstubAllEnvs());

import app from './app.js';

/**
 * Regression tests for OpenAPI contract loading over HTTP.
 * The validator loads the spec on the first request, before checking route exemptions.
 * An unreadable spec therefore breaks both the root route and request validation.
 */
describe('the assembled application', () => {
  it('serves its root route', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
  });

  it('rejects a request that violates the OpenAPI contract', async () => {
    // Supply a bearer header so request validation reaches the empty batch, which violates minItems.
    const response = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ transactions: [] });

    expect(response.status).toBe(400);
  });
});
