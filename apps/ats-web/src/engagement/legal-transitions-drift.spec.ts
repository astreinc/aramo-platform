import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS } from './legal-transitions';
import { ENGAGEMENT_STATE_VALUES, type EngagementState } from './types';

// Drift smoke spec (Amendment v1.1 / RULING 2, R7).
//
// The ats-web hand-mirrors the inline `const ALLOWED:` matrix in
// libs/engagement/src/lib/engagement-state.ts's canTransition(). The BE
// source is the source of truth; this FE mirror is the UX (only-legal-
// targets-offered in the transition control). To prevent silent drift if a
// future PR changes the BE matrix, this spec reads the BE source as text,
// brace-balances the ALLOWED object literal, regex-extracts the entries,
// and asserts the whole matrix is structurally equal to the FE mirror.
// Any edge added, removed, or changed fails here.
//
// The marker is `const ALLOWED:` (NOT pipeline's `const LEGAL_TRANSITIONS:`)
// because the engagement matrix is an inline const inside canTransition(),
// not a top-level export. Do NOT ask the BE to hoist it.

const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/engagement/src/lib/engagement-state.ts',
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

function parseBeMatrix(source: string): Record<EngagementState, string[]> {
  // Anchor on the ALLOWED declaration and walk the literal object until
  // the matching closing brace. A brace-balance scan is robust to the
  // inline comments and the trailing `return ALLOWED[from]?...` that
  // follow the object in the BE source.
  const startMarker = 'const ALLOWED:';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `legal-transitions drift: could not find "${startMarker}" in ${BE_SOURCE}`,
    );
  }
  const openIdx = source.indexOf('{', startIdx);
  if (openIdx === -1) {
    throw new Error('legal-transitions drift: could not find opening brace');
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
    throw new Error('legal-transitions drift: unbalanced braces');
  }
  const body = source.slice(openIdx + 1, endIdx);
  // Each entry is `state: [..],` possibly preceded by line comments.
  // Capture identifier + bracketed contents (empty for terminals).
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
  return result as Record<EngagementState, string[]>;
}

describe('engagement legal-transitions drift smoke spec', () => {
  it('the FE mirror is structurally deep-equal to the BE ALLOWED matrix', () => {
    const source = readFileSync(BE_SOURCE, 'utf8');
    const beMatrix = parseBeMatrix(source);
    const beKeys = Object.keys(beMatrix).sort();
    const feKeys = Object.keys(LEGAL_TRANSITIONS).sort();
    expect(feKeys).toEqual(beKeys);
    // All 11 states appear as keys in both.
    expect(beKeys.length).toBe(ENGAGEMENT_STATE_VALUES.length);
    // Structural matrix equality (set-of-targets per key).
    expect(normalize(LEGAL_TRANSITIONS)).toEqual(normalize(beMatrix));
  });

  it('terminals carry no outgoing targets', () => {
    expect(LEGAL_TRANSITIONS.maybe).toEqual([]);
    expect(LEGAL_TRANSITIONS.passed).toEqual([]);
    expect(LEGAL_TRANSITIONS.not_interested).toEqual([]);
    expect(LEGAL_TRANSITIONS.submitted).toEqual([]);
  });

  it('every target referenced is a valid EngagementState', () => {
    for (const targets of Object.values(LEGAL_TRANSITIONS)) {
      for (const t of targets) {
        expect(ENGAGEMENT_STATE_VALUES).toContain(t);
      }
    }
  });
});
