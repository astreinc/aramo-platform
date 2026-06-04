import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// ADR-0015 Decision 10 (Scope of AI consumption): AI/LLM provider
// consumption is confined to libs/ai-draft and its declared consumers.
// New substrate surfaces (libs/import column-mapping at A8-2; libs/resume-parse
// at A8-3b; future parse/inference surfaces) MUST use deterministic
// heuristics. The no-llm-boundary structural specs enforce this at CI by
// scanning every .ts source file under the target lib for forbidden imports
// or identifiers.
//
// This helper lifts the assertion logic that A8-2 first authored, so the
// two (and any future) specs share one source of truth for what "no LLM"
// structurally means -- they cannot drift.

export interface NoLlmBoundaryViolation {
  file: string;
  pattern: string;
  line: string;
}

const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['@aramo/ai-draft import', /from\s+['"]@aramo\/ai-draft/],
  ['@anthropic-ai/sdk import', /from\s+['"]@anthropic-ai\/sdk/],
  ['DraftProvider identifier', /\bDraftProvider\b/],
  ['anthropic identifier', /\banthropic\b/i],
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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

/**
 * Scan every .ts file under `libRoot` for forbidden LLM-substrate
 * imports or identifiers. Returns an empty array on a clean scan.
 *
 * Comments are stripped before matching, so files that legitimately
 * NAME the forbidden tokens in prose (the spec file itself; doc-
 * comments that cite ADR-0015) do not trigger violations.
 *
 * `excludeBasenames` skips files by basename -- typically the spec
 * file itself, which contains the forbidden tokens in regex literals.
 */
export function findNoLlmBoundaryViolations(
  libRoot: string,
  opts: { excludeBasenames?: ReadonlyArray<string> } = {},
): NoLlmBoundaryViolation[] {
  const exclude = new Set(opts.excludeBasenames ?? []);
  const files = walk(libRoot).filter((f) => !exclude.has(basename(f)));

  const violations: NoLlmBoundaryViolation[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      const m = code.match(pattern);
      if (m !== null) {
        const lineIdx = code.slice(0, m.index ?? 0).split('\n').length;
        const line = code.split('\n')[lineIdx - 1] ?? '';
        violations.push({ file, pattern: label, line: line.trim() });
      }
    }
  }
  return violations;
}

/**
 * Assert that a module file does not import the forbidden LLM substrate
 * packages. Mirrors the lint:nx-boundaries graph-check at the file level
 * (the lint check covers the package-edge; this check covers the
 * import-statement edge).
 *
 * Comments are stripped before matching, so module files that mention
 * the forbidden tokens in doc-comments (citing ADR-0015 or naming the
 * libs being excluded from the imports list) do not trigger.
 */
export function assertModuleHasNoLlmImports(moduleFileContents: string): void {
  const code = stripComments(moduleFileContents);
  if (/@aramo\/ai-draft/.test(code)) {
    throw new Error('module file imports @aramo/ai-draft (forbidden by ADR-0015 Decision 10)');
  }
  if (/@anthropic-ai\/sdk/.test(code)) {
    throw new Error('module file imports @anthropic-ai/sdk (forbidden by ADR-0015 Decision 10)');
  }
}
