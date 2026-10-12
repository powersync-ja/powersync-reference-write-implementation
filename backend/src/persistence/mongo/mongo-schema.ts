import * as z from 'zod';
import type { Db } from 'mongodb';

/** Validates and converts the fields of one collection's documents. */
export type CollectionSchema = z.ZodObject;

type FieldDefinition = { bsonType?: string | string[] };

/**
 * Clients send SQLite values: booleans as 0/1 and dates as strings (or epoch numbers).
 * Each builder accepts that wire format strictly and converts it to the BSON type.
 */
const BSON_TYPE_VALIDATORS: Record<string, () => z.ZodType> = {
  string: () => z.string(),
  bool: () => z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => v === true || v === 1),
  int: () => z.int(),
  long: () => z.int(),
  double: () => z.number(),
  decimal: () => z.number(),
  number: () => z.number(),
  date: () => z.union([z.string(), z.number()]).pipe(z.coerce.date())
};
BSON_TYPE_VALIDATORS.boolean = BSON_TYPE_VALIDATORS.bool;

function fieldSchema(def: FieldDefinition | undefined): z.ZodType {
  const types = [def?.bsonType ?? []].flat();
  const nullable = types.includes('null');
  const validators = types.filter((t) => t !== 'null').map((t) => BSON_TYPE_VALIDATORS[t]);

  // A field with no declared type, or any type we can't check (object, array, objectId, binData, ...),
  // passes through unchanged. The database validator still enforces it.
  if (validators.length === 0 || validators.some((v) => v === undefined)) {
    return z.unknown();
  }

  const schemas = validators.map((v) => v());
  const base = schemas.length === 1 ? schemas[0] : z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  return nullable ? base.nullable() : base;
}

/**
 * Builds a Zod schema from a collection's $jsonSchema validator. Fields in `required` must be
 * present (PATCH operations use `.partial()`); fields the validator doesn't mention pass through.
 * `_id` is excluded because the persister sets it from the operation's row ID.
 */
export function collectionSchemaFromJsonSchema(jsonSchema: Record<string, unknown>): CollectionSchema {
  const properties = (jsonSchema.properties ?? {}) as Record<string, FieldDefinition>;
  const required = new Set(Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : []);

  const shape: Record<string, z.ZodType> = {};
  for (const [field, def] of Object.entries(properties)) {
    if (field === '_id') continue;
    const schema = fieldSchema(def);
    shape[field] = required.has(field) ? schema : schema.optional();
  }

  return z.looseObject(shape);
}

/**
 * Reads collection schemas from $jsonSchema validators at startup.
 * Collections without a validator are omitted; the default persister rejects writes to them.
 * Restart the backend after changing validators to refresh these schemas.
 */
export async function discoverSchema(db: Db): Promise<Record<string, CollectionSchema>> {
  const schema: Record<string, CollectionSchema> = {};
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();

  for (const info of collections) {
    const jsonSchema = (info.options as { validator?: { $jsonSchema?: Record<string, unknown> } } | undefined)
      ?.validator?.$jsonSchema;
    if (jsonSchema) {
      schema[info.name] = collectionSchemaFromJsonSchema(jsonSchema);
    }
  }

  return schema;
}
