import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUARANTEE_TERMS_SOURCE_VALUES, TERMS_REMEDY_POLICY_VALUES } from './guarantee-terms-types';

// Drift smoke spec (R1 / ADR-0029). The Guarantee Terms form offers two closed vocabularies —
// the terms provenance source type and the remedy policy — both owned by @aramo/placement
// (importing it is a forbidden domain edge). This spec reads the BE registries as text and
// asserts the FE mirrors are exactly equal (values + order). A source type (e.g. a premature
// CLIENT_CONTRACT) or a remedy policy added/removed/reordered at the BE fails here.

const BE_SOURCE_TYPES = resolve(__dirname, '../../../../libs/placement/src/lib/permanent/guarantee-terms-source.ts');
const BE_LIFECYCLE = resolve(__dirname, '../../../../libs/placement/src/lib/lifecycle/placement-lifecycle.ts');

function arrayLiteral(source: string, marker: string): string[] {
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) throw new Error(`guarantee-terms drift: could not find "${marker}"`);
  const openIdx = source.indexOf('[', startIdx);
  const closeIdx = source.indexOf(']', openIdx);
  if (openIdx === -1 || closeIdx === -1) throw new Error(`guarantee-terms drift: no array for "${marker}"`);
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

describe('guarantee-terms vocabulary drift smoke spec', () => {
  it('the FE GUARANTEE_TERMS_SOURCE_VALUES mirror equals the BE GUARANTEE_TERMS_SOURCE_TYPES (order-exact)', () => {
    const be = arrayLiteral(readFileSync(BE_SOURCE_TYPES, 'utf8'), 'const GUARANTEE_TERMS_SOURCE_TYPES =');
    expect(be).toEqual(['MANUAL', 'IMPORTED']);
    expect([...GUARANTEE_TERMS_SOURCE_VALUES]).toEqual(be);
  });

  it('the FE TERMS_REMEDY_POLICY_VALUES mirror equals the BE REMEDY_POLICIES (order-exact)', () => {
    const be = arrayLiteral(readFileSync(BE_LIFECYCLE, 'utf8'), 'const REMEDY_POLICIES =');
    expect(be).toHaveLength(3);
    expect([...TERMS_REMEDY_POLICY_VALUES]).toEqual(be);
  });
});
