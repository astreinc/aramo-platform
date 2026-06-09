import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS } from './submittal-state';
import { SUBMITTAL_STATE_VALUES, type SubmittalStateValue } from './types';

// Drift smoke spec — mirrors the R1 pipeline pattern.
//
// The recruiter-console hand-mirrors libs/submittal/src/lib/submittal-
// state.ts's canTransition ALLOWED matrix. The BE source is the source
// of truth; this FE mirror is the UX (only-legal-targets-offered in the
// wizard). To prevent silent drift if a future PR changes the BE matrix,
// this spec reads the BE source as text, regex-extracts ALLOWED, and
// asserts structural deep-equal.

const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/submittal/src/lib/submittal-state.ts',
);

function normalize(
  matrix: Record<string, readonly string[]>,
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const key of Object.keys(matrix)) {
    out[key] = new Set(matrix[key]);
  }
  return out;
}

function parseBeAllowed(source: string): Record<SubmittalStateValue, string[]> {
  // Anchor on the inner ALLOWED declaration inside canTransition.
  const startMarker = 'const ALLOWED:';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `submittal-state drift: could not find "${startMarker}" in ${BE_SOURCE}`,
    );
  }
  const openIdx = source.indexOf('{', startIdx);
  if (openIdx === -1) {
    throw new Error('submittal-state drift: could not find opening brace');
  }
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error('submittal-state drift: unbalanced braces');
  }
  const body = source.slice(openIdx + 1, endIdx);
  // Each entry: `status: [..],` possibly preceded by comments.
  const entryRe = /(?:^|\n)\s*([a-z_]+)\s*:\s*\[([\s\S]*?)\],/g;
  const result: Record<string, string[]> = {};
  let match: RegExpExecArray | null = entryRe.exec(body);
  while (match !== null) {
    const key = match[1];
    const inner = match[2];
    const targets: string[] = [];
    const targetRe = /'([a-z_]+)'/g;
    let targetMatch: RegExpExecArray | null = targetRe.exec(inner);
    while (targetMatch !== null) {
      targets.push(targetMatch[1]);
      targetMatch = targetRe.exec(inner);
    }
    result[key] = targets;
    match = entryRe.exec(body);
  }
  return result as Record<SubmittalStateValue, string[]>;
}

describe('submittal-state drift smoke spec', () => {
  it('the FE mirror is structurally deep-equal to the BE ALLOWED matrix', () => {
    const source = readFileSync(BE_SOURCE, 'utf8');
    const beMatrix = parseBeAllowed(source);
    const beKeys = Object.keys(beMatrix).sort();
    const feKeys = Object.keys(LEGAL_TRANSITIONS).sort();
    expect(feKeys).toEqual(beKeys);
    expect(beKeys.length).toBe(SUBMITTAL_STATE_VALUES.length);
    expect(normalize(LEGAL_TRANSITIONS)).toEqual(normalize(beMatrix));
  });

  it('terminals carry no outgoing transitions', () => {
    expect(LEGAL_TRANSITIONS.confirmed).toEqual([]);
    expect(LEGAL_TRANSITIONS.revoked).toEqual([]);
  });

  it('every target referenced is a valid SubmittalStateValue', () => {
    for (const targets of Object.values(LEGAL_TRANSITIONS)) {
      for (const t of targets) {
        expect(SUBMITTAL_STATE_VALUES).toContain(t);
      }
    }
  });
});
