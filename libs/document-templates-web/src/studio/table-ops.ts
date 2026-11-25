import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from '@aramo/template-content';

import type { StudioTable } from '../studio-codec';

// TEMPLATE-CONTENT-2 (C-13) — pure table operations of the Studio's table editor. Each op
// returns a NEW table (the undo history keeps the old block value), or `{ limit }` when the
// C-1 limit (TABLE_MAX_ROWS × TABLE_MAX_COLUMNS, from the shared rules) stops it. A table
// always keeps at least one row and one column: removing the last one deletes the table
// instead (the editor's "Delete table").

export const TABLE_DEFAULT_ROWS = 3;
export const TABLE_DEFAULT_COLUMNS = 2;
export { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS };

export type TableOpResult = { readonly table: StudioTable } | { readonly limit: string };

export const TABLE_ROW_LIMIT_MESSAGE = `A table can have up to ${TABLE_MAX_ROWS} rows.`;
export const TABLE_COLUMN_LIMIT_MESSAGE = `A table can have up to ${TABLE_MAX_COLUMNS} columns.`;

export function columnsOf(t: StudioTable): number {
  return t.rows[0]?.length ?? 0;
}

/** Clamp a requested size to the limits (the insert dialog). */
export function clampTableSize(rows: number, cols: number): { rows: number; cols: number } {
  const n = (v: number, max: number, dflt: number) => (Number.isFinite(v) ? Math.min(max, Math.max(1, Math.round(v))) : dflt);
  return { rows: n(rows, TABLE_MAX_ROWS, TABLE_DEFAULT_ROWS), cols: n(cols, TABLE_MAX_COLUMNS, TABLE_DEFAULT_COLUMNS) };
}

/** Insert an empty row at index `at` (0 … rows). A row above the header row is never added. */
export function addRow(t: StudioTable, at: number): TableOpResult {
  if (t.rows.length >= TABLE_MAX_ROWS) return { limit: TABLE_ROW_LIMIT_MESSAGE };
  const i = Math.max(t.header ? 1 : 0, Math.min(t.rows.length, at));
  const rows = [...t.rows];
  rows.splice(i, 0, Array.from({ length: columnsOf(t) }, () => ''));
  return { table: { ...t, rows } };
}

/** Remove row `at`. Null when it is the only row (delete the table instead). */
export function removeRow(t: StudioTable, at: number): StudioTable | null {
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return t.rows.length <= 1 ? null : t;
  const rows = t.rows.filter((_r, i) => i !== at);
  // Removing the header row turns the header off (the next row is ordinary content).
  return { header: t.header && at !== 0, rows };
}

/** Insert an empty column at index `at` (0 … columns). */
export function addColumn(t: StudioTable, at: number): TableOpResult {
  const cols = columnsOf(t);
  if (cols >= TABLE_MAX_COLUMNS) return { limit: TABLE_COLUMN_LIMIT_MESSAGE };
  const i = Math.max(0, Math.min(cols, at));
  return { table: { ...t, rows: t.rows.map((r) => [...r.slice(0, i), '', ...r.slice(i)]) } };
}

/** Remove column `at`. Null when it is the only column (delete the table instead). */
export function removeColumn(t: StudioTable, at: number): StudioTable | null {
  const cols = columnsOf(t);
  if (cols <= 1) return null;
  if (at < 0 || at >= cols) return t;
  return { ...t, rows: t.rows.map((r) => r.filter((_c, i) => i !== at)) };
}

/** Turn the header row on / off. */
export function setHeader(t: StudioTable, on: boolean): StudioTable {
  return { ...t, header: on };
}

/** The next / previous cell in reading order; null past either end. */
export function stepCell(t: StudioTable, r: number, c: number, dir: 1 | -1): { r: number; c: number } | null {
  const cols = columnsOf(t);
  const i = r * cols + c + dir;
  if (i < 0 || i >= t.rows.length * cols) return null;
  return { r: Math.floor(i / cols), c: i % cols };
}
