import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GATED_RECRUITING_STATUS_VALUES,
  RECRUITING_STATUS_VALUES,
  SELECTABLE_RECRUITING_STATUS_VALUES,
} from './types';

// Drift smoke spec (T1-d — the PipelineStatus mirror + drift-guard precedent,
// libs/pipeline .. apps/ats-web/src/pipeline/legal-transitions-drift.spec.ts).
//
// apps/ats-web hand-mirrors the RecruitingStatus value space from the BE source
// libs/requisition/src/lib/dto/requisition-status.ts (the FE app cannot import
// @aramo/requisition — a forbidden domain edge). The BE is the source of truth;
// this spec reads it as TEXT and asserts the FE mirror is exactly equal so a
// future BE value add/rename/gate-change fails HERE, not silently at runtime.

const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/requisition/src/lib/dto/requisition-status.ts',
);

// Pull the string members out of a `NAME = [ ... ] as const` array literal.
function parseArray(source: string, name: string): string[] {
  const startMarker = `${name} = [`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`recruiting-status drift: could not find "${startMarker}" in ${BE_SOURCE}`);
  }
  const openIdx = source.indexOf('[', startIdx);
  const closeIdx = source.indexOf(']', openIdx);
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(`recruiting-status drift: could not bound the array literal for ${name}`);
  }
  const body = source.slice(openIdx + 1, closeIdx);
  const out: string[] = [];
  const re = /'([a-z_]+)'/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(body);
  }
  return out;
}

describe('recruiting-status drift smoke spec', () => {
  const source = readFileSync(BE_SOURCE, 'utf8');

  it('the FE RECRUITING_STATUS_VALUES mirror is order-identical to the BE source', () => {
    const beValues = parseArray(source, 'RECRUITING_STATUS_VALUES');
    expect([...RECRUITING_STATUS_VALUES]).toEqual(beValues);
  });

  it('the FE GATED_RECRUITING_STATUS_VALUES mirror matches the BE source', () => {
    const beGated = parseArray(source, 'GATED_RECRUITING_STATUS_VALUES');
    expect([...GATED_RECRUITING_STATUS_VALUES].sort()).toEqual([...beGated].sort());
  });

  it('every gated value is a member of the full value set', () => {
    for (const g of GATED_RECRUITING_STATUS_VALUES) {
      expect(RECRUITING_STATUS_VALUES).toContain(g);
    }
  });

  it('the selectable set is the full set minus the gated set (no gated value is selectable)', () => {
    for (const g of GATED_RECRUITING_STATUS_VALUES) {
      expect(SELECTABLE_RECRUITING_STATUS_VALUES).not.toContain(g);
    }
    expect(SELECTABLE_RECRUITING_STATUS_VALUES.length).toBe(
      RECRUITING_STATUS_VALUES.length - GATED_RECRUITING_STATUS_VALUES.length,
    );
  });

  it('the superseded values are gone from the mirror (active -> open, full -> submittals_closed)', () => {
    expect(RECRUITING_STATUS_VALUES as readonly string[]).not.toContain('active');
    expect(RECRUITING_STATUS_VALUES as readonly string[]).not.toContain('full');
    expect(RECRUITING_STATUS_VALUES).toContain('open');
    expect(RECRUITING_STATUS_VALUES).toContain('submittals_closed');
  });
});
