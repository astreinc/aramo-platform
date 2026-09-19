import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HYDRATION_PROJECTION_POLICIES,
  HYDRATION_RESOLUTION_REASONS,
  HYDRATION_RESOLUTION_STATUSES,
  HYDRATION_SOURCE_TYPES,
  HYDRATION_VALUE_STATES,
} from './profile-hydration';

// TI-1E-B1 drift guard — the FE hydration vocabulary MUST stay 1:1 with the BE
// source. ats-web can't import @aramo/talent-record, so we read the BE source
// text and assert every FE value is declared there and the counts match. Any BE
// vocabulary change fails CI here until the FE mirror is updated.
const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/talent-record/src/lib/talent-record-reconcile.repository.ts',
);

// Extract the string members of a `export type X = 'a' | 'b' | ...;` union.
function beUnion(typeName: string, source: string): string[] {
  const m = new RegExp(`export type ${typeName}\\s*=([^;]*);`, 's').exec(source);
  const body = m?.[1];
  if (body === undefined) throw new Error(`${typeName} not found in BE source`);
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '');
}

describe('profile-hydration vocabulary drift guard (FE mirror ↔ BE source)', () => {
  const source = readFileSync(BE_SOURCE, 'utf8');

  it('value_state matches the BE TalentProfileValueState 1:1', () => {
    expect(beUnion('TalentProfileValueState', source)).toEqual([...HYDRATION_VALUE_STATES]);
  });

  it('source_type matches the BE TalentProfileSourceType 1:1', () => {
    expect(beUnion('TalentProfileSourceType', source)).toEqual([...HYDRATION_SOURCE_TYPES]);
  });

  it('projection_policy matches the BE TalentProfileProjectionPolicy 1:1', () => {
    expect(beUnion('TalentProfileProjectionPolicy', source)).toEqual([
      ...HYDRATION_PROJECTION_POLICIES,
    ]);
  });

  it('resolution_status matches the BE TalentProfileResolutionStatus 1:1', () => {
    expect(beUnion('TalentProfileResolutionStatus', source)).toEqual([
      ...HYDRATION_RESOLUTION_STATUSES,
    ]);
  });

  it('resolution_reason matches the BE TalentProfileResolutionReason 1:1', () => {
    expect(beUnion('TalentProfileResolutionReason', source)).toEqual([
      ...HYDRATION_RESOLUTION_REASONS,
    ]);
  });
});
