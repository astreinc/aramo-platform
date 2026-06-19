import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_STATUS_VALUES,
  ENGAGEMENT_TYPE_VALUES,
} from './stated-fields';

// Drift guard — the FE stated-fields vocab MUST stay 1:1 with the BE source
// (libs/talent-record/src/lib/dto/stated-fields.ts). The ats-web
// can't import @aramo/talent-record, so we read the BE source text and assert
// every FE value is declared there and the counts match. Any BE vocabulary
// change (stated-fields amendment §9 requires a further amendment) fails CI
// here until the FE mirror is updated.

const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/talent-record/src/lib/dto/stated-fields.ts',
);

function beArray(constName: string, source: string): string[] {
  const m = new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(source);
  const body = m?.[1];
  if (body === undefined) throw new Error(`${constName} not found in BE source`);
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '');
}

describe('stated-fields drift guard (FE mirror ↔ BE source)', () => {
  const source = readFileSync(BE_SOURCE, 'utf8');

  it('availability_status vocabulary matches the BE source 1:1', () => {
    expect(beArray('AVAILABILITY_STATUS_VALUES', source)).toEqual([
      ...AVAILABILITY_STATUS_VALUES,
    ]);
  });

  it('engagement_type vocabulary matches the BE source 1:1', () => {
    expect(beArray('ENGAGEMENT_TYPE_VALUES', source)).toEqual([
      ...ENGAGEMENT_TYPE_VALUES,
    ]);
  });
});
