import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RECRUITER_DISPOSITION_REASON_GROUPS } from './disposition-reasons';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R1 (DEF-6) — DRIFT spec (fs-read precedent:
// ats-web cannot import @aramo/pipeline). Reads the backend reason taxonomy as TEXT and asserts
// the FE recruiter reason list equals it per authority, so a backend change fails here.
const BE_SOURCE = resolve(__dirname, '../../../../libs/pipeline/src/lib/pipeline-disposition.ts');

function backendReasons(authority: string): string[] {
  const src = readFileSync(BE_SOURCE, 'utf8');
  const m = new RegExp(`${authority}: \\[([^\\]]*)\\]`, 'm').exec(src);
  if (m === null) throw new Error(`authority ${authority} not found in ${BE_SOURCE}`);
  return Array.from(m[1]!.matchAll(/'([a-z_]+)'/g)).map((x) => x[1]!);
}

describe('recruiter disposition reasons — drift vs libs/pipeline', () => {
  for (const group of RECRUITER_DISPOSITION_REASON_GROUPS) {
    it(`${group.authority} matches the backend list exactly`, () => {
      expect([...group.reasons]).toEqual(backendReasons(group.authority));
    });
  }

  it('offers exactly the 3 recruiter authorities (never DOWNSTREAM_OUTCOME)', () => {
    expect(RECRUITER_DISPOSITION_REASON_GROUPS.map((g) => g.authority)).toEqual(['RECRUITER', 'TALENT', 'ENGAGEMENT']);
  });
});
