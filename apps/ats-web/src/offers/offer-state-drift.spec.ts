import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OFFER_STATES } from './types';

// Offer Lifecycle (D7) — drift guard. ats-web hand-mirrors the OfferState value
// space from the BE source (libs/placement/src/lib/lifecycle/offer-lifecycle.ts);
// the FE app cannot import @aramo/placement (a forbidden domain edge). The BE is
// the source of truth; this reads it as TEXT and asserts the FE mirror is exactly
// equal so a future BE add/rename fails HERE, not silently at runtime. (Mirrors
// the recruiting-status / pipeline drift-guard precedent.)
const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/placement/src/lib/lifecycle/offer-lifecycle.ts',
);

function parseArray(source: string, name: string): string[] {
  const start = source.indexOf(`${name} = [`);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  const body = source.slice(open + 1, close);
  const out: string[] = [];
  const re = /'([A-Z_]+)'/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[1]!);
    m = re.exec(body);
  }
  return out;
}

describe('offer-state drift smoke spec', () => {
  it('the FE OFFER_STATES mirror is order-identical to the BE OFFER_STATES', () => {
    const be = parseArray(readFileSync(BE_SOURCE, 'utf8'), 'OFFER_STATES');
    expect([...OFFER_STATES]).toEqual(be);
  });
});
