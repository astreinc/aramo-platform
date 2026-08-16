import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PERMANENT_PLACEMENT_STATE_VALUES, REMEDY_POLICY_VALUES } from './permanent-placement-types';

// Drift smoke spec (R1 / ADR-0029). The ats-web hand-mirrors the BE permanent-placement
// lifecycle vocabulary — importing @aramo/placement is a forbidden domain edge. The BE is the
// source of truth; this spec reads it as text, extracts the `as const` array literals, and
// asserts the FE mirror is exactly equal (values AND order, since both are presentation-stable).
// Any state or remedy policy added/removed/reordered at the BE fails here.

const BE_LIFECYCLE = resolve(__dirname, '../../../../libs/placement/src/lib/lifecycle/placement-lifecycle.ts');

// Extract the string members of an `export const NAME = [ 'A', 'B', … ] as const;` literal,
// preserving source order.
function arrayLiteral(source: string, marker: string): string[] {
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) throw new Error(`permanent-placement drift: could not find "${marker}"`);
  const openIdx = source.indexOf('[', startIdx);
  const closeIdx = source.indexOf(']', openIdx);
  if (openIdx === -1 || closeIdx === -1) throw new Error(`permanent-placement drift: no array for "${marker}"`);
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

describe('permanent-placement vocabulary drift smoke spec', () => {
  const source = readFileSync(BE_LIFECYCLE, 'utf8');

  it('the FE PERMANENT_PLACEMENT_STATE_VALUES mirror equals the BE PERMANENT_PLACEMENT_STATES (order-exact)', () => {
    const be = arrayLiteral(source, 'const PERMANENT_PLACEMENT_STATES =');
    expect(be).toHaveLength(7);
    expect([...PERMANENT_PLACEMENT_STATE_VALUES]).toEqual(be);
  });

  it('the FE REMEDY_POLICY_VALUES mirror equals the BE REMEDY_POLICIES (order-exact)', () => {
    const be = arrayLiteral(source, 'const REMEDY_POLICIES =');
    expect(be).toHaveLength(3);
    expect([...REMEDY_POLICY_VALUES]).toEqual(be);
  });
});
