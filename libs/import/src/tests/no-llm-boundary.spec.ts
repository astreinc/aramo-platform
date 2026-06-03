import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// PR-A8-2 — THE no-LLM-boundary structural spec (proof §4.6).
//
// ADR-0015 LEAD RULING: the column-mapping inference is a
// DETERMINISTIC HEURISTIC (header-synonym + data-shape sampling), NOT
// an LLM call. An LLM in the import path would be a NEW AI
// consumption surface, against the "AI isolated to ai-draft/drafts"
// posture. This spec asserts the boundary STRUCTURALLY — by scanning
// every .ts source file under libs/import/ for forbidden imports.
//
// The assertion: no file in libs/import imports or names:
//   - @aramo/ai-draft (or any subpath)
//   - @anthropic-ai/sdk
//   - DraftProvider (the ai-draft contract)
//   - any 'llm'/'LLM'/'anthropic' bare identifier
//
// If a future PR genuinely needs LLM-assisted mapping, it amends
// ADR-0015 and updates this spec deliberately. Until then, this spec
// is the structural guard.

const LIB_ROOT = resolve(__dirname, '..', '..');

const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['@aramo/ai-draft import', /from\s+['"]@aramo\/ai-draft/],
  ['@anthropic-ai/sdk import', /from\s+['"]@anthropic-ai\/sdk/],
  ['DraftProvider identifier', /\bDraftProvider\b/],
  ['anthropic identifier', /\banthropic\b/i],
  // Match standalone llm/LLM tokens (not e.g. "fullmoon" or "html").
  ['llm/LLM identifier', /\b(llm|LLM)\b/],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (st.isFile() && name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('PR-A8-2 — no-LLM-boundary (ADR-0015, structural)', () => {
  const allFiles = walk(LIB_ROOT).filter((f) => {
    // Exclude THIS spec from the scan (it legitimately names the
    // forbidden tokens in regex literals + comments).
    if (f.endsWith('no-llm-boundary.spec.ts')) return false;
    return true;
  });

  it('libs/import contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations: Array<{ file: string; pattern: string; line: string }> =
      [];
    for (const file of allFiles) {
      const src = readFileSync(file, 'utf8');
      // Strip comments to avoid false-positives from prose mentions
      // (the controller/service files DO mention ADR-0015 + LLM in
      // comments — that's the documentation, not a wire-up).
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => {
          const i = l.indexOf('//');
          return i === -1 ? l : l.slice(0, i);
        })
        .join('\n');
      for (const [label, pattern] of FORBIDDEN_PATTERNS) {
        const m = code.match(pattern);
        if (m !== null) {
          const lineIdx = code.slice(0, m.index ?? 0).split('\n').length;
          const line = code.split('\n')[lineIdx - 1] ?? '';
          violations.push({ file, pattern: label, line: line.trim() });
        }
      }
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('libs/import package has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    // Structural: the module file enumerates its imports — assert
    // none reaches for the forbidden libs. Parallel to the
    // lint:nx-boundaries graph-check, but at the file level.
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/import.module.ts'),
      'utf8',
    );
    expect(moduleFile).not.toMatch(/@aramo\/ai-draft/);
    expect(moduleFile).not.toMatch(/@anthropic-ai\/sdk/);
  });
});
