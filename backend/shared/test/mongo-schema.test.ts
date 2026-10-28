import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  collectionSchemaFromJsonSchema,
  convertId,
  idConverterFromJsonSchema
} from '../src/persistence/mongo/mongo-schema.ts';
import { createMongoMapper } from '../src/mapping/mongo.ts';
import { FatalOperationError } from '../src/errors.ts';
import type { CrudEntry } from '../src/types.ts';

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

describe('mongo _id conversion', () => {
  const withId = (bsonType: unknown) =>
    idConverterFromJsonSchema({ bsonType: 'object', properties: { _id: { bsonType } } });
  const convert = (bsonType: unknown, id: string) => convertId({ t: withId(bsonType) }, 't', id);
  const hex = '507f1f77bcf86cd799439011';

  it('converts ObjectId strings', () => {
    expect(convert('objectId', hex)).toEqual(new ObjectId(hex));
  });

  it('rejects malformed ObjectId strings as INVALID_DATA', () => {
    expect(() => convert('objectId', 'nope')).toThrow(FatalOperationError);
  });

  it('keeps string ids and converts integer ids', () => {
    expect(convert('string', 'a')).toBe('a');
    expect(convert('int', '42')).toBe(42);
  });

  it.each([[undefined], [['objectId', 'string']], ['uuid']])('refuses to start with _id type %j', (t) => {
    expect(() => withId(t)).toThrow(/_id/);
  });
});
