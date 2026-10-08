import type { CrudEntry } from '../types.js';

export interface MappedEntry {
  table: string;
  op: 'PUT' | 'PATCH' | 'DELETE';
  id: string;
  data: Record<string, unknown>;
}

/**
 * Transforms a CrudEntry into a MappedEntry for persistence.
 * Return null to skip the operation.
 */
export type EntryMapper = (entry: CrudEntry) => MappedEntry | null;
