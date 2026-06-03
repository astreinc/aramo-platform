import type { FieldType } from './field-catalog.js';

// PR-A8-2 — data-shape pattern recognition. THE Lead-review surface
// (the §2 design: are these patterns sound?). For headers that DON'T
// synonym-match a field, the suggestion service samples the row
// VALUES under that header and runs each value through the patterns
// below. A pattern whose match-rate ≥ DATA_SHAPE_THRESHOLD over the
// sample is a viable match, with confidence proportional to the rate.
//
// Patterns are intentionally STRICT to avoid false positives:
//   - emailPattern: standard RFC-5321-ish (no surrounding spaces).
//   - urlPattern: http:// | https:// | www.* prefix.
//   - phonePattern: 7-20 chars of digits + common separators + 'ext'.
//   - isoDatePattern: YYYY-MM-DD prefix (catches ISO timestamps too).
//   - usDatePattern: M/D/Y or MM/DD/YYYY (no looser MM-DD-YY to avoid
//                    clashing with phone-like '617-555-0100').
//   - usZipPattern: 5 digits or 5-4 ZIP+4. US-only is sufficient for
//                   the A8-1 import targets (Aramo's deployed markets).
//   - intPattern:  pure integer.
//   - moneyPattern: optional $, optional commas, decimal optional.
//   - booleanPattern: true/false/yes/no/y/n/1/0 (case-insensitive).
//
// The patterns produce a matched FieldType, NOT specific field
// names. The suggestion service maps the matched type back to
// fields of that type in the target's catalog. If multiple fields
// share the type (e.g. company has phone1/phone2/fax_number all
// 'phone'), the data-shape match alone CANNOT distinguish them — the
// service falls back to "no synonym-strong choice, pick the first
// unmapped phone-typed field" and downgrades confidence to `low`.
// This is the Lead's call: a data-shape-only match is intentionally
// weaker than a synonym match.

export const DATA_SHAPE_THRESHOLD = 0.5; // ≥ 50% of sampled values must match

const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const urlPattern = /^(https?:\/\/|www\.)/i;
const phonePattern = /^[+\d][\d\s()+\-.x]{6,19}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;
const usDatePattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const usZipPattern = /^\d{5}(-\d{4})?$/;
const intPattern = /^-?\d+$/;
const moneyPattern = /^\$?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/;
const booleanPattern = /^(true|false|yes|no|y|n|1|0)$/i;

export interface PatternMatch {
  readonly matchedType: FieldType;
  readonly rate: number; // 0..1 fraction of sampled values that matched
}

// Stringify a sampled value before pattern-testing. null / undefined
// are dropped (sample size excludes them); numbers / booleans are
// coerced (CSV readers sometimes pre-parse).
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return String(v);
}

// Rate a single pattern against the sampled values: matched /
// non-empty. The denominator is the count of NON-EMPTY samples (so a
// column of mostly nulls doesn't yield a false-high rate).
function matchRate(samples: readonly unknown[], pattern: RegExp): number {
  let matched = 0;
  let nonEmpty = 0;
  for (const v of samples) {
    const s = asString(v);
    if (s === null) continue;
    nonEmpty += 1;
    if (pattern.test(s)) matched += 1;
  }
  if (nonEmpty === 0) return 0;
  return matched / nonEmpty;
}

// Return the matched FieldType (and match rate) for a column's
// sampled values. Returns null if nothing exceeds the threshold.
// Pattern precedence on ties: more-specific patterns first (zip > int,
// money > int, date > nothing, email > url, etc.) — order in the
// returned list matters when multiple patterns match the same sample.
export function inferDataShape(samples: readonly unknown[]): PatternMatch | null {
  if (samples.length === 0) return null;
  // Specific patterns first; intPattern would also match a ZIP, money
  // would also match an int, etc. — the first ≥ threshold wins.
  const ordered: ReadonlyArray<readonly [FieldType, RegExp]> = [
    ['email', emailPattern],
    ['url', urlPattern],
    ['date', isoDatePattern],
    ['date', usDatePattern],
    ['boolean', booleanPattern],
    // usZip BEFORE intPattern so a 5-digit ZIP isn't classified as int.
    // The 'string' FieldType is the catalog's type for zip codes.
    ['string', usZipPattern],
    ['money', moneyPattern],
    ['int', intPattern],
    ['phone', phonePattern],
  ];
  let best: PatternMatch | null = null;
  for (const [type, pattern] of ordered) {
    const rate = matchRate(samples, pattern);
    if (rate < DATA_SHAPE_THRESHOLD) continue;
    if (best === null || rate > best.rate) {
      best = { matchedType: type, rate };
      // Don't break — let a higher-rate later pattern win. But on
      // EQUAL rates the earlier (more specific) pattern stays. Stable.
    }
  }
  return best;
}

// Internal export for the spec — assert pattern soundness in unit tests.
export const __INTERNAL_PATTERNS = {
  emailPattern,
  urlPattern,
  phonePattern,
  isoDatePattern,
  usDatePattern,
  usZipPattern,
  intPattern,
  moneyPattern,
  booleanPattern,
} as const;
