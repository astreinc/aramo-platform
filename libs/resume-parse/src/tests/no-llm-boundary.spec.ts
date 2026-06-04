import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// A8-3b — THE no-LLM-boundary structural spec for libs/resume-parse
// (the proof §3 / §4.3 invariant).
//
// ADR-0015 Decision 10 (Scope of AI consumption): AI/LLM provider
// consumption is confined to libs/ai-draft and its declared consumers.
// New substrate surfaces -- libs/import column-mapping (A8-2),
// libs/resume-parse résumé parse (A8-3b), and any future parse/inference
// surfaces -- MUST use deterministic heuristics, NOT LLM calls.
//
// The assertion: no file in libs/resume-parse imports or names
// @aramo/ai-draft, @anthropic-ai/sdk, DraftProvider, or any
// llm/LLM/anthropic identifier. The assertion is run via the lifted
// helper (@aramo/common :: findNoLlmBoundaryViolations), so this spec
// and the libs/import twin share one source of truth -- they cannot
// drift.
//
// If a future PR genuinely needs LLM-assisted résumé parsing, it
// amends ADR-0015 (revising Decision 10) and updates this spec
// deliberately. Until then, this spec is the structural guard.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('A8-3b — no-LLM-boundary (ADR-0015 Decision 10, structural)', () => {
  it('libs/resume-parse contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      // Exclude THIS spec file -- it legitimately names the forbidden
      // tokens in the import line.
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('libs/resume-parse module file has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/resume-parse.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
