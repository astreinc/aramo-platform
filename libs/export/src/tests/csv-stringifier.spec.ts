import { describe, expect, it } from 'vitest';

import { __testing, stringifyCsv } from '../lib/csv-stringifier.js';

// PR-A8-4 unit — RFC-4180 escaping. The CSV-correctness proof is a
// load-bearing §3 assertion in the integration spec (a field with
// embedded comma / quote / newline must round-trip); this unit spec
// covers the building-block escaper at the function level so the
// integration spec doesn't need to also be the unit spec.

const { stringifyField, stringifyRow } = __testing;

describe('csv-stringifier', () => {
  describe('stringifyField — RFC-4180 escaping', () => {
    it('plain ASCII passes through unquoted', () => {
      expect(stringifyField('hello')).toBe('hello');
    });

    it('null becomes the empty field (not literal "null")', () => {
      expect(stringifyField(null)).toBe('');
    });

    it('undefined becomes the empty field', () => {
      expect(stringifyField(undefined)).toBe('');
    });

    it('a comma forces quoting', () => {
      expect(stringifyField('Acme, Inc.')).toBe('"Acme, Inc."');
    });

    it('a double quote is doubled inside quotes', () => {
      expect(stringifyField('She said "hi"')).toBe('"She said ""hi"""');
    });

    it('a newline forces quoting', () => {
      expect(stringifyField('line1\nline2')).toBe('"line1\nline2"');
    });

    it('CR forces quoting', () => {
      expect(stringifyField('a\rb')).toBe('"a\rb"');
    });

    it('booleans stringify to lowercase', () => {
      expect(stringifyField(true)).toBe('true');
      expect(stringifyField(false)).toBe('false');
    });

    it('Date stringifies to ISO 8601', () => {
      const d = new Date(Date.UTC(2026, 5, 3, 12, 0, 0));
      expect(stringifyField(d)).toBe('2026-06-03T12:00:00.000Z');
    });

    it('numbers stringify via String(n) — no quoting', () => {
      expect(stringifyField(42)).toBe('42');
      expect(stringifyField(0)).toBe('0');
    });
  });

  describe('stringifyRow', () => {
    it('comma-joins fields with each one independently escaped', () => {
      expect(stringifyRow(['a', 'b, with comma', null, 42])).toBe(
        'a,"b, with comma",,42',
      );
    });
  });

  describe('stringifyCsv', () => {
    it('emits header row followed by data rows separated by CRLF', () => {
      const csv = stringifyCsv({
        columns: ['name', 'city'],
        rows: [
          { name: 'Acme', city: 'Boston' },
          { name: 'Beta', city: 'NYC' },
        ],
      });
      expect(csv).toBe('name,city\r\nAcme,Boston\r\nBeta,NYC\r\n');
    });

    it('a missing key in a row emits the empty field (not undefined)', () => {
      const csv = stringifyCsv({
        columns: ['a', 'b', 'c'],
        rows: [{ a: '1', c: '3' }],
      });
      expect(csv).toBe('a,b,c\r\n1,,3\r\n');
    });

    it('header row only when no data rows', () => {
      const csv = stringifyCsv({ columns: ['a', 'b'], rows: [] });
      expect(csv).toBe('a,b\r\n');
    });

    it('round-trips fields with embedded delimiter / quote / newline', () => {
      // The integration spec's load-bearing CSV-correctness proof: a
      // field with a comma, a double quote, and a newline survives
      // round-trip through a standard RFC-4180 reader. Here we use a
      // simple state-machine parser to verify the stringifier's output
      // is parseable.
      const original = 'comma, "quote", and\nnewline';
      const csv = stringifyCsv({
        columns: ['payload'],
        rows: [{ payload: original }],
      });
      const parsed = parseRfc4180Csv(csv);
      expect(parsed).toEqual([['payload'], [original]]);
    });
  });
});

/**
 * Minimal RFC-4180 parser for the round-trip proof. NOT production
 * code — kept here in the spec so the assertion is self-contained
 * (the spec's authority for "this is RFC-4180" is this parser plus
 * the field-level tests above).
 */
function parseRfc4180Csv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
