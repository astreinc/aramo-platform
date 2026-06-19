import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS } from './legal-transitions';
import { PIPELINE_STATUS_VALUES, type PipelineStatus } from './types';

// Drift smoke spec (Q4 ruling, R1).
//
// The ats-web hand-mirrors libs/pipeline/src/lib/pipeline-state.ts's
// LEGAL_TRANSITIONS map. The BE source is the source of truth; this FE
// mirror is the UX (only-legal-targets-offered in the "Move to…" menu).
// To prevent silent drift if a future PR changes the BE matrix, this
// spec reads the BE source as text, regex-extracts LEGAL_TRANSITIONS,
// and asserts the whole matrix is structurally equal to the FE mirror.
// Any edge added, removed, or changed fails here.

const BE_SOURCE = resolve(
  __dirname,
  '../../../../libs/pipeline/src/lib/pipeline-state.ts',
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

function parseBeMatrix(source: string): Record<PipelineStatus, string[]> {
  // Anchor on the LEGAL_TRANSITIONS declaration and walk the literal
  // object until the matching closing brace. Regex over comments would
  // be brittle; a brace-balance scan is robust to the inline comments
  // that exist in the BE source.
  const startMarker = 'const LEGAL_TRANSITIONS:';
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
  // Each entry is `status: [..],` possibly preceded by line comments.
  // Capture identifier + bracketed contents.
  const entryRe =
    /(?:^|\n)\s*([a-z_]+)\s*:\s*\[([\s\S]*?)\],/g;
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
  return result as Record<PipelineStatus, string[]>;
}

describe('legal-transitions drift smoke spec', () => {
  it('the FE mirror is structurally deep-equal to the BE LEGAL_TRANSITIONS', () => {
    const source = readFileSync(BE_SOURCE, 'utf8');
    const beMatrix = parseBeMatrix(source);
    const beKeys = Object.keys(beMatrix).sort();
    const feKeys = Object.keys(LEGAL_TRANSITIONS).sort();
    expect(feKeys).toEqual(beKeys);
    // Spot check: all 11 statuses appear as keys in both.
    expect(beKeys.length).toBe(PIPELINE_STATUS_VALUES.length);
    // Structural matrix equality (set-of-targets per key).
    expect(normalize(LEGAL_TRANSITIONS)).toEqual(normalize(beMatrix));
  });

  it('terminals carry no outgoing targets', () => {
    expect(LEGAL_TRANSITIONS.placed).toEqual([]);
    expect(LEGAL_TRANSITIONS.not_in_consideration).toEqual([]);
    expect(LEGAL_TRANSITIONS.client_declined).toEqual([]);
  });

  it('every target referenced is a valid PipelineStatus', () => {
    for (const targets of Object.values(LEGAL_TRANSITIONS)) {
      for (const t of targets) {
        expect(PIPELINE_STATUS_VALUES).toContain(t);
      }
    }
  });
});
