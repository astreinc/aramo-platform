import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PLACEMENT_STATE_VALUES,
  STATE_POSITION,
  TRANSITIONS,
  type PlacementState,
} from './types';

// Drift smoke spec (R1). The ats-web hand-mirrors the BE placement lifecycle
// (libs/placement/src/lib/lifecycle/placement-lifecycle.ts) — importing
// @aramo/placement is a forbidden domain edge. The BE is the source of truth;
// this spec reads it as text, brace-scans the TRANSITIONS and STATE_POSITION
// literals, and asserts the FE mirror is structurally equal. Any edge or
// position added/removed/changed at the BE fails here.

const BE_SOURCE = resolve(__dirname, '../../../../libs/placement/src/lib/lifecycle/placement-lifecycle.ts');

function objectBody(source: string, marker: string): string {
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) throw new Error(`placement drift: could not find "${marker}"`);
  const openIdx = source.indexOf('{', startIdx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  throw new Error('placement drift: unbalanced braces');
}

function parseTransitions(source: string): Record<string, string[]> {
  const body = objectBody(source, 'const TRANSITIONS =');
  const entryRe = /(?:^|\n)\s*([A-Z_]+)\s*:\s*\[([\s\S]*?)\],/g;
  const result: Record<string, string[]> = {};
  let m: RegExpExecArray | null = entryRe.exec(body);
  while (m !== null) {
    const targets: string[] = [];
    const targetRe = /'([A-Z_]+)'/g;
    let t: RegExpExecArray | null = targetRe.exec(m[2]);
    while (t !== null) { targets.push(t[1]); t = targetRe.exec(m[2]); }
    result[m[1]] = targets;
    m = entryRe.exec(body);
  }
  return result;
}

function parsePositions(source: string): Record<string, string> {
  const body = objectBody(source, 'const STATE_POSITION =');
  const entryRe = /(?:^|\n)\s*([A-Z_]+)\s*:\s*'([A-Z_]+)'/g;
  const result: Record<string, string> = {};
  let m: RegExpExecArray | null = entryRe.exec(body);
  while (m !== null) { result[m[1]] = m[2]; m = entryRe.exec(body); }
  return result;
}

function normalize(matrix: Record<string, readonly string[]>): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const k of Object.keys(matrix)) out[k] = new Set(matrix[k]);
  return out;
}

describe('placement matrix drift smoke spec', () => {
  const source = readFileSync(BE_SOURCE, 'utf8');

  it('the FE TRANSITIONS mirror is structurally deep-equal to the BE', () => {
    const be = parseTransitions(source);
    expect(Object.keys(be).sort()).toEqual([...PLACEMENT_STATE_VALUES].sort());
    expect(normalize(TRANSITIONS)).toEqual(normalize(be));
  });

  it('the FE STATE_POSITION mirror is deep-equal to the BE', () => {
    const be = parsePositions(source);
    expect(be).toEqual(STATE_POSITION);
  });

  it('every transition target is a valid PlacementState', () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const t of targets) expect(PLACEMENT_STATE_VALUES).toContain(t as PlacementState);
    }
  });
});
