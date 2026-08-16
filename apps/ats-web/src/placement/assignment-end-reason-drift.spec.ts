import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASSIGNMENT_END_REASON_DISPLAY_VALUES, ASSIGNMENT_END_REASON_VALUES } from './types';

// Track 7 / T7-PX drift smoke spec (R1 / ADR-0029). The ats-web hand-mirrors the BE
// ContractAssignmentEndReason enum (importing @aramo/placement is a forbidden domain edge). The
// BE Prisma schema is the source of truth; this reads it as text, extracts the enum members, and
// asserts: (a) the FE DISPLAY vocabulary equals the full BE enum (so a converted source's
// end_reason always renders), and (b) the user-choosable End-dialog VALUES deliberately EXCLUDE
// CONVERTED_TO_PERMANENT (it is set only by the conversion command, never chosen manually).

const BE_SCHEMA = resolve(__dirname, '../../../../libs/placement/prisma/schema.prisma');

function enumMembers(source: string, name: string): string[] {
  const start = source.indexOf(`enum ${name} {`);
  if (start === -1) throw new Error(`assignment-end-reason drift: enum ${name} not found`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const body = source.slice(open + 1, close);
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;
    if (/^[A-Z_]+$/.test(line)) out.push(line);
  }
  return out;
}

describe('assignment end-reason vocabulary drift smoke spec', () => {
  const be = enumMembers(readFileSync(BE_SCHEMA, 'utf8'), 'ContractAssignmentEndReason');

  it('the FE DISPLAY vocabulary equals the full BE ContractAssignmentEndReason enum', () => {
    expect(be).toContain('CONVERTED_TO_PERMANENT');
    expect([...ASSIGNMENT_END_REASON_DISPLAY_VALUES].sort()).toEqual([...be].sort());
  });

  it('the user-choosable End-dialog VALUES exclude CONVERTED_TO_PERMANENT (set only by conversion)', () => {
    expect(ASSIGNMENT_END_REASON_VALUES).not.toContain('CONVERTED_TO_PERMANENT');
    expect([...ASSIGNMENT_END_REASON_VALUES].sort()).toEqual(['CLIENT_ENDED', 'COMPLETED', 'WORKER_ENDED']);
  });
});
