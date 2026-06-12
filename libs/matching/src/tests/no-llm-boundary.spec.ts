import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// Job-Module / ADR-0015 v1.2 G6 — the matching surface stays DETERMINISTIC.
//
// ADR-0015 v1.2 authorizes LLM use ONLY for JD + GoldenProfile generation
// from a brief (libs/requisition, the 2nd declared ai-draft consumer). It
// does NOT authorize LLM use in matching — the engine consumes the
// (confirmed) GoldenProfile deterministically; the LLM never participates
// in matching. This structural spec asserts libs/matching imports no
// LLM/ai-draft/anthropic substrate (it would FAIL the build otherwise),
// keeping the boundary honest as the Job-Module PR adds the new consumer
// next door.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('Job-Module G6 — no-LLM-boundary (libs/matching stays deterministic)', () => {
  it('libs/matching contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('libs/matching module has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/matching.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
