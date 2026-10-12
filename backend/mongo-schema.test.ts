import { describe, expect, it } from 'vitest';
import { collectionSchemaFromJsonSchema } from './src/persistence/mongo/mongo-schema.js';
import { createMongoMapper } from './src/mapping/mongo.js';
import { FatalOperationError } from './src/errors.js';
import type { CrudEntry } from './src/types.js';

const todos = collectionSchemaFromJsonSchema({
  bsonType: 'object',
  required: ['_id', 'description', 'completed'],
  properties: {
    _id: { bsonType: 'string' },
    description: { bsonType: 'string' },
    completed: { bsonType: 'bool' },
    priority: { bsonType: 'int' },
    score: { bsonType: ['double', 'null'] },
    created_at: { bsonType: 'date' },
    tags: { bsonType: 'array' }
  }
});
const mapper = createMongoMapper({ todos });
const entry = (op: CrudEntry['op'], op_data: Record<string, unknown>): CrudEntry =>
  ({ op, table: 'todos', id: 't1', op_data }) as CrudEntry;

describe('mongo mapper with Zod schemas', () => {
  it('converts SQLite wire values to BSON types', () => {
    const mapped = mapper(
      entry('PUT', {
        description: 'x',
        completed: 1,
        priority: 2,
        score: null,
        created_at: '2026-01-02T03:04:05.000Z',
        tags: ['a'],
        extra: 'kept'
      })
    );
    expect(mapped?.id).toBe('t1');
    expect(mapped?.data).toEqual({
      description: 'x',
      completed: true,
      priority: 2,
      score: null,
      created_at: new Date('2026-01-02T03:04:05.000Z'),
      tags: ['a'],
      extra: 'kept'
    });
  });

  it('allows PATCH to omit required fields', () => {
    expect(mapper(entry('PATCH', { completed: 0 }))?.data).toEqual({ completed: false });
  });

  it('requires required fields on PUT', () => {
    expect(() => mapper(entry('PUT', { description: 'x' }))).toThrow(FatalOperationError);
  });

  it.each([
    ['non-numeric int', { priority: 'abc' }],
    ['fractional int', { priority: 1.5 }],
    ['string boolean', { completed: 'false' }],
    ['invalid date', { created_at: 'garbage' }],
    ['null for non-nullable field', { description: null }]
  ])('rejects %s as INVALID_DATA', (_name, patch) => {
    try {
      mapper(entry('PATCH', patch));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FatalOperationError);
      expect((error as FatalOperationError).errorCode).toBe('INVALID_DATA');
      expect((error as FatalOperationError).details).toBeTruthy();
    }
  });
});
