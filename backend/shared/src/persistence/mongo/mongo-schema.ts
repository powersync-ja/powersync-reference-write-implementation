import * as z from 'zod';
import { FatalOperationError } from '../../errors.ts';
import { ObjectId, type Db } from 'mongodb';

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
 * Operation row IDs arrive as strings. `_id` is stored with whatever BSON type the validator
 * declares, so the ID must be converted or the filter never matches the stored document.
 */
const ID_VALIDATORS: Record<string, () => z.ZodType> = {
  string: () => z.string(),
  objectId: () =>
    z
      .string()
      .refine((v) => ObjectId.isValid(v) && /^[0-9a-fA-F]{24}$/.test(v), 'Not a 24-character hex ObjectId')
      .transform((v) => new ObjectId(v)),
  int: () =>
    z
      .string()
      .regex(/^-?\d+$/, 'Not an integer')
      .transform(Number)
      .pipe(z.int()),
  long: () =>
    z
      .string()
      .regex(/^-?\d+$/, 'Not an integer')
      .transform(Number)
      .pipe(z.int())
};

/** Converts one collection's row ID strings to its declared `_id` type. */
export type IdConverter = z.ZodType;

function idConverter(def: FieldDefinition | undefined): IdConverter {
  const types = [def?.bsonType ?? []].flat();
  const builder = types.length === 1 ? ID_VALIDATORS[types[0]] : undefined;
  if (!builder) {
    throw new Error(
      `The $jsonSchema validator must declare "_id" with a single bsonType of string, objectId, int or long ` +
        `(found ${types.length ? types.join('|') : 'none'}), so row IDs can be converted to the stored type.`
    );
  }
  return builder();
}

/**
 * Builds a Zod schema from a collection's $jsonSchema validator. Fields in `required` must be
 * present (PATCH operations use `.partial()`); fields the validator doesn't mention pass through.
 * `_id` is excluded; the row ID is converted separately (see `idConverterFromJsonSchema`).
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
 * Builds the row ID converter from a collection's `_id` definition. `_id` must be declared with a
 * supported bsonType, otherwise this throws and startup fails.
 */
export function idConverterFromJsonSchema(jsonSchema: Record<string, unknown>): IdConverter {
  const properties = (jsonSchema.properties ?? {}) as Record<string, FieldDefinition>;
  return idConverter(properties._id);
}

/** Converts a row ID string to the `_id` type declared by the collection's validator. */
export function convertId(converters: Record<string, IdConverter>, table: string, id: string): unknown {
  const converter = converters[table];
  if (!converter) return id;
  const result = converter.safeParse(id);
  if (!result.success) {
    throw new FatalOperationError('INVALID_DATA', `Invalid _id "${id}": ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

/**
 * Reads collection schemas and `_id` converters from $jsonSchema validators at startup.
 * Collections without a validator are omitted; the default persister rejects writes to them.
 * Restart the backend after changing validators to refresh these.
 */
export async function discoverCollections(
  db: Db
): Promise<{ schema: Record<string, CollectionSchema>; idConverters: Record<string, IdConverter> }> {
  const schema: Record<string, CollectionSchema> = {};
  const idConverters: Record<string, IdConverter> = {};
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();

  for (const info of collections) {
    const jsonSchema = (info.options as { validator?: { $jsonSchema?: Record<string, unknown> } } | undefined)
      ?.validator?.$jsonSchema;
    if (jsonSchema) {
      schema[info.name] = collectionSchemaFromJsonSchema(jsonSchema);
      idConverters[info.name] = idConverterFromJsonSchema(jsonSchema);
    }
  }

  return { schema, idConverters };
}
