import type { Db } from 'mongodb';

export type TypeConverter = (v: unknown) => unknown;

export type TableSchema = Record<string, TypeConverter>;

export const types: Record<string, TypeConverter> = {
  date: (v) => new Date(v as string | number),
  boolean: (v) => !!v,
  string: (v) => String(v),
  number: (v) => Number(v)
};

const BSON_TYPE_CONVERTERS: Record<string, TypeConverter> = {
  date: types.date,
  bool: types.boolean,
  boolean: types.boolean,
  string: types.string,
  int: types.number,
  long: types.number,
  double: types.number,
  decimal: types.number,
  number: types.number
};

/**
 * Derives a TableSchema from a $jsonSchema validator's `properties`. A field whose bsonType we
 * don't recognize (object, array, objectId, binData, ...) is left out of the result — applySchema
 * treats a missing entry as "pass this field through unconverted", not "drop it".
 */
function tableSchemaFromJsonSchema(jsonSchema: Record<string, unknown>): TableSchema {
  const properties = (jsonSchema.properties ?? {}) as Record<string, { bsonType?: string | string[] }>;
  const schema: TableSchema = {};

  for (const [field, def] of Object.entries(properties)) {
    const bsonType = Array.isArray(def?.bsonType) ? def.bsonType.find((t) => t !== 'null') : def?.bsonType;
    const converter = bsonType ? BSON_TYPE_CONVERTERS[bsonType] : undefined;
    if (converter) {
      schema[field] = converter;
    }
  }

  return schema;
}

/**
 * Reads type mappings from collection $jsonSchema validators at startup.
 * Collections without a validator are omitted; the default persister rejects writes to them.
 * Restart the backend after changing validators to refresh these mappings.
 */
export async function discoverSchema(db: Db): Promise<Record<string, TableSchema>> {
  const schema: Record<string, TableSchema> = {};
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();

  for (const info of collections) {
    const jsonSchema = (info.options as { validator?: { $jsonSchema?: Record<string, unknown> } } | undefined)
      ?.validator?.$jsonSchema;
    if (jsonSchema) {
      schema[info.name] = tableSchemaFromJsonSchema(jsonSchema);
    }
  }

  return schema;
}

/**
 * Converts fields with a matching type converter and preserves all other values.
 * Use MongoDB schema validation to enforce types in the database.
 */
export function applySchema(tableSchema: TableSchema, data: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(data)) {
    if (rawValue == null) {
      converted[key] = rawValue;
      continue;
    }
    const converter = tableSchema[key];
    converted[key] = converter ? converter(rawValue) : rawValue;
  }

  return converted;
}
