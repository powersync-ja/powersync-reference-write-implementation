import type { EntryMapper } from './types.js';

/**
 * Preserves table and field names without converting or validating values.
 * Replace this mapper if your client and database schemas differ.
 * See docs/schema-mapping.md.
 */
export const defaultMapper: EntryMapper = (entry) => {
  console.error(
    `defaultMapper: writing "${entry.table}" without renaming, type conversion, or validation. ` +
      'See docs/schema-mapping.md to configure a custom mapper.'
  );

  const data = entry.op_data ?? {};
  const id = (entry.id ?? data.id) as string;

  if (entry.op === 'DELETE') {
    return { table: entry.table, op: entry.op, id, data: {} };
  }

  const { id: _discardId, ...fields } = data;
  return { table: entry.table, op: entry.op, id, data: fields };
};
