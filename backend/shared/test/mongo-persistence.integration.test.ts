import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as mongo from 'mongodb';
import { createMongoPersister } from '../src/persistence/mongo/mongo-persistence.ts';
import type { CrudEntry, Persister } from '../src/types.ts';

/**
 * Needs a real MongoDB replica set (transactions). Skipped unless MONGO_TEST_URL is set, e.g.
 *
 *   docker run -d --name mongo-test -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
 *   docker exec mongo-test mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
 *   MONGO_TEST_URL='mongodb://localhost:27017/?directConnection=true' pnpm test mongo-persistence
 *
 * Each run uses its own database, which is dropped afterwards.
 */
const baseUrl = process.env.MONGO_TEST_URL;
const dbName = `ps_test_${process.pid}`;
const auth = { sub: 'test', claims: {} };
const hex = '507f1f77bcf86cd799439011';

const withDb = (url: string) => {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
};

const entry = (op: CrudEntry['op'], table: string, id: string, op_data?: Record<string, unknown>): CrudEntry => ({
  op,
  table,
  id,
  ...(op_data ? { op_data } : {})
});

describe.skipIf(!baseUrl)('MongoDB persister _id conversion', () => {
  let client: mongo.MongoClient;
  let db: mongo.Db;
  let persister: Persister;

  const validator = (idType: string) => ({
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name'],
      properties: { _id: { bsonType: idType }, name: { bsonType: 'string' }, done: { bsonType: 'bool' } }
    }
  });

  beforeAll(async () => {
    client = await new mongo.MongoClient(baseUrl!).connect();
    db = client.db(dbName);
    await db.createCollection('oid_items', { validator: validator('objectId') });
    await db.createCollection('str_items', { validator: validator('string') });
    await db.createCollection('int_items', { validator: validator('int') });
    persister = await createMongoPersister(withDb(baseUrl!));
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  it('PUT, PATCH and DELETE hit ObjectId documents', async () => {
    const oid = new mongo.ObjectId(hex);
    const items = db.collection('oid_items');

    await persister.updateBatch([entry('PUT', 'oid_items', hex, { id: hex, name: 'a', done: 0 })], auth);
    expect(await items.find().toArray()).toEqual([{ _id: oid, name: 'a', done: false }]);

    // PUT again must replace, not duplicate.
    await persister.updateBatch([entry('PUT', 'oid_items', hex, { id: hex, name: 'b', done: 1 })], auth);
    expect(await items.find().toArray()).toEqual([{ _id: oid, name: 'b', done: true }]);

    await persister.updateBatch([entry('PATCH', 'oid_items', hex, { done: 0 })], auth);
    expect(await items.findOne({ _id: oid })).toMatchObject({ name: 'b', done: false });

    await persister.updateBatch([entry('DELETE', 'oid_items', hex)], auth);
    expect(await items.countDocuments()).toBe(0);
  });

  it('string and int _id collections keep working', async () => {
    await persister.updateBatch(
      [
        entry('PUT', 'str_items', 'abc', { name: 's' }),
        entry('PUT', 'int_items', '7', { name: 'i' }),
        entry('PATCH', 'str_items', 'abc', { name: 's2' }),
        entry('PATCH', 'int_items', '7', { name: 'i2' })
      ],
      auth
    );
    expect(await db.collection('str_items').find().toArray()).toEqual([{ _id: 'abc', name: 's2' }]);
    expect(await db.collection('int_items').find().toArray()).toEqual([{ _id: 7, name: 'i2' }]);

    await persister.updateBatch([entry('DELETE', 'str_items', 'abc'), entry('DELETE', 'int_items', '7')], auth);
    expect(await db.collection('str_items').countDocuments()).toBe(0);
    expect(await db.collection('int_items').countDocuments()).toBe(0);
  });

  it('rejects a malformed ObjectId and rolls back the batch', async () => {
    await expect(
      persister.updateBatch(
        [entry('PUT', 'str_items', 'ok', { name: 'x' }), entry('PUT', 'oid_items', 'not-hex', { name: 'y' })],
        auth
      )
    ).rejects.toMatchObject({ errorCode: 'INVALID_DATA', operationIndex: 1 });
    expect(await db.collection('str_items').countDocuments()).toBe(0);
  });

  it('custom mapper still gets _id conversion', async () => {
    const custom = await createMongoPersister(withDb(baseUrl!), (e) => ({
      table: e.table,
      op: e.op,
      id: e.id,
      data: { name: 'custom' }
    }));
    await custom.updateBatch([entry('PUT', 'oid_items', hex)], auth);
    expect(await db.collection('oid_items').findOne({ _id: new mongo.ObjectId(hex) })).toMatchObject({
      name: 'custom'
    });
    await custom.updateBatch([entry('DELETE', 'oid_items', hex)], auth);
    expect(await db.collection('oid_items').countDocuments()).toBe(0);
  });

  it('refuses to start when a validator does not declare _id', async () => {
    await db.createCollection('no_id', {
      validator: { $jsonSchema: { bsonType: 'object', properties: { name: { bsonType: 'string' } } } }
    });
    await expect(createMongoPersister(withDb(baseUrl!))).rejects.toThrow(/_id/);
    await db.dropCollection('no_id');
  });
});
