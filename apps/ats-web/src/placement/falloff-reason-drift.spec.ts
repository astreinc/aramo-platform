import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FALLOFF_REASON_CODES, FALLOFF_REASON_LABELS } from './falloff-reason-labels';

// Drift smoke spec (R1 / ADR-0029). The falloff reason RadioGroup offers a closed, governed
// vocabulary; the BE owns the canonical registry in @aramo/placement
// (libs/placement/src/lib/reasons/permanent-falloff-reasons.ts) — importing it is a forbidden
// domain edge. This spec reads the BE registry as text, extracts the code array, and asserts the
// FE mirror is exactly equal (values AND order — order is presentation-stable on both sides).
// A code added/removed/reordered at the BE, or a re-introduced OTHER, fails here.

const BE_REASONS = resolve(__dirname, '../../../../libs/placement/src/lib/reasons/permanent-falloff-reasons.ts');

function arrayLiteral(source: string, marker: string): string[] {
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) throw new Error(`falloff-reason drift: could not find "${marker}"`);
  const openIdx = source.indexOf('[', startIdx);
  const closeIdx = source.indexOf(']', openIdx);
  if (openIdx === -1 || closeIdx === -1) throw new Error(`falloff-reason drift: no array for "${marker}"`);
  const body = source.slice(openIdx + 1, closeIdx);
  const out: string[] = [];
  const re = /'([A-Z_]+)'/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(body);
  }
  return out;
}

describe('falloff reason vocabulary drift smoke spec', () => {
  const source = readFileSync(BE_REASONS, 'utf8');

  it('the FE FALLOFF_REASON_CODES mirror equals the BE PERMANENT_FALLOFF_REASON_CODES (order-exact)', () => {
    const be = arrayLiteral(source, 'const PERMANENT_FALLOFF_REASON_CODES =');
    expect(be).toHaveLength(7);
    expect([...FALLOFF_REASON_CODES]).toEqual(be);
  });

  it('there is NO OTHER / free-text reason (closed vocabulary, §3.1)', () => {
    expect(FALLOFF_REASON_CODES).not.toContain('OTHER');
  });

  it('every code has a distinct human label', () => {
    const labels = FALLOFF_REASON_CODES.map((c) => FALLOFF_REASON_LABELS[c]);
    expect(new Set(labels).size).toBe(FALLOFF_REASON_CODES.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});
