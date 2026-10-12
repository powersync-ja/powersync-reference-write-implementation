import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generate, OUTPUT } from './scripts/generate-edge-validator.ts';
import { validateBatchBody } from './src/write/validate-batch.ts';

const mocks = vi.hoisted(() => ({ updateBatch: vi.fn() }));
vi.mock('./src/persistence/persister.ts', () => ({ getPersister: async () => ({ updateBatch: mocks.updateBatch }) }));
vi.mock('./src/auth/authorizer.ts', () => ({ authorizer: { authorize: () => true } }));
vi.mock('./src/auth/verifier.ts', () => ({ verifier: { verify: async () => ({ sub: 'verified', claims: {} }) } }));
import app from './app.ts';

const entry = { op: 'PUT', table: 'items', id: '1' };
const many = (n: number) => Array.from({ length: n }, () => ({ crud: [entry] }));

/** Bodies the two validators must agree on. */
const cases: Record<string, unknown> = {
  minimal: { transactions: [{ crud: [entry] }] },
  'empty transaction': { transactions: [{ crud: [] }] },
  'full entry': {
    transactions: [
      {
        transaction_id: 7,
        crud: [{ ...entry, transaction_id: 7, op_data: { a: 1 }, previous_values: { a: 0 }, metadata: 'm' }]
      }
    ]
  },
  'extra properties': { transactions: [{ crud: [{ ...entry, extra: true }], extra: 1 }], on_fatal_error: 'skip' },
  'fifty transactions': { transactions: many(50) },
  'fifty-one transactions': { transactions: many(51) },
  'empty batch': { transactions: [] },
  'missing transactions': {},
  'transactions not an array': { transactions: {} },
  'missing crud': { transactions: [{}] },
  'missing id': { transactions: [{ crud: [{ op: 'PUT', table: 'items' }] }] },
  'numeric id': { transactions: [{ crud: [{ ...entry, id: 1 }] }] },
  'unknown op': { transactions: [{ crud: [{ ...entry, op: 'UPSERT' }] }] },
  'null transaction_id': { transactions: [{ transaction_id: null, crud: [entry] }] },
  'string transaction_id': { transactions: [{ transaction_id: '7', crud: [entry] }] },
  'fractional transaction_id': { transactions: [{ transaction_id: 1.5, crud: [entry] }] },
  'op_data array': { transactions: [{ crud: [{ ...entry, op_data: [] }] }] },
  'op_data null': { transactions: [{ crud: [{ ...entry, op_data: null }] }] },
  'numeric metadata': { transactions: [{ crud: [{ ...entry, metadata: 1 }] }] },
  'array body': [{ crud: [entry] }]
};

describe('generated edge validator', () => {
  it('matches the committed output', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(generate());
  });

  it.each(Object.entries(cases))('agrees with express-openapi-validator: %s', async (_name, body) => {
    mocks.updateBatch.mockResolvedValue(undefined);
    const response = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer test')
      .send(body as object);
    expect([200, 400]).toContain(response.status);
    const result = validateBatchBody(body);
    expect(result.valid, JSON.stringify(response.body)).toBe(response.status === 200);
    if (!result.valid) expect(result.message).toBe(response.body.message);
  });
});
