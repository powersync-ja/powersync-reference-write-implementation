import { defaultMapper } from '@powersync/write-core/mapping/default.ts';
import type { EntryMapper } from '@powersync/write-core/mapping/types.ts';

/**
 * Maps each uploaded operation to the table and columns to write, or returns null to skip it.
 * Replace with your own mapping; see docs/schema-mapping.md.
 */
export const mapper: EntryMapper = defaultMapper;
