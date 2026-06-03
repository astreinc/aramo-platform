// PR-A8-4 — RFC-4180 CSV stringifier. Hand-rolled (no `csv-stringify` /
// `papaparse` in the tree; the dependency footprint of a CSV writer
// isn't worth the imported surface for ~30 lines of escaping).
//
// Rules (RFC-4180):
//   - Records separated by CRLF (\r\n).
//   - Fields separated by `,`.
//   - A field that contains CR, LF, `,` or `"` is enclosed in double
//     quotes; an embedded `"` is doubled (`""`).
//   - Non-string values are stringified: null/undefined → empty field
//     (NOT the literal "null"); Date → ISO 8601; Boolean → 'true'/'false';
//     everything else → String(value).
//
// The escaping is the load-bearing CSV-correctness proof at §3 — a
// field with embedded comma/quote/newline round-trips through a
// standard RFC-4180 reader (the integration spec verifies this).

const FIELD_DELIMITER = ',';
const RECORD_TERMINATOR = '\r\n';
const QUOTE = '"';
const ESCAPED_QUOTE = '""';

const NEEDS_QUOTING = /[",\r\n]/;

function stringifyField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (typeof value === 'string') s = value;
  else s = String(value);

  if (NEEDS_QUOTING.test(s)) {
    return `${QUOTE}${s.replaceAll(QUOTE, ESCAPED_QUOTE)}${QUOTE}`;
  }
  return s;
}

function stringifyRow(values: readonly unknown[]): string {
  return values.map(stringifyField).join(FIELD_DELIMITER);
}

/**
 * Stringify a header row + zero or more data rows as an RFC-4180 CSV
 * document. The output ALWAYS uses `\r\n` line terminators (incl. the
 * trailing terminator after the final record — RFC-4180 Section 2 §2:
 * "The last record in the file may or may not have an ending line
 * break" — we emit one for parser-leniency).
 *
 * `rows` is an array of objects keyed by `columns`. A column missing
 * from a given row is emitted as the empty field (NOT the literal
 * 'undefined'). This matches the row-projection contract in the export
 * service (the field catalog enumerates every legal column; a row's
 * missing key means the source column was null/undefined in Postgres).
 */
export function stringifyCsv(args: {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
}): string {
  const headerLine = stringifyRow(args.columns);
  const dataLines = args.rows.map((row) =>
    stringifyRow(args.columns.map((c) => row[c])),
  );
  return [headerLine, ...dataLines].join(RECORD_TERMINATOR) + RECORD_TERMINATOR;
}

// Exported for the spec — round-trip assertion uses the same escape.
export const __testing = { stringifyField, stringifyRow };
