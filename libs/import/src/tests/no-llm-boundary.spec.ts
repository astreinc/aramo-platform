import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// PR-A8-2 — THE no-LLM-boundary structural spec (proof §4.6).
//
// ADR-0015 Decision 10 (Scope of AI consumption, added at A8-3b): AI/LLM
// provider consumption is confined to libs/ai-draft and its declared
// consumers. New substrate surfaces -- import column-mapping (A8-2),
// résumé parse (A8-3b), and any future parse/inference surfaces -- MUST
// use deterministic heuristics. An LLM in any of these surfaces is a NEW
// AI-consumption surface requiring an explicit ADR amendment.
//
// At A8-3b the assertion logic was lifted to @aramo/common
// (findNoLlmBoundaryViolations) so this spec and the libs/resume-parse
// twin share one source of truth -- they cannot drift.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('PR-A8-2 — no-LLM-boundary (ADR-0015 Decision 10, structural)', () => {
  it('libs/import contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      // Exclude THIS spec file from the scan (it legitimately names the
      // forbidden tokens in the import line).
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('libs/import package has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/import.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
