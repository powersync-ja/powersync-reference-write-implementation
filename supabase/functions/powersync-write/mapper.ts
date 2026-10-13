import { defaultMapper } from '../../../backend/src/mapping/default.ts';
import type { EntryMapper } from '../../../backend/src/mapping/types.ts';

/**
 * Maps each uploaded operation to the table and columns to write, or returns null to skip it.
 * Replace with your own mapping; see docs/schema-mapping.md.
 */
export const mapper: EntryMapper = defaultMapper;
