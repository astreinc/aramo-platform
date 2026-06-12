import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// Job-Module / ADR-0015 v1.2 G6 — the examination surface stays
// DETERMINISTIC. Examination persists the deterministic engine's snapshot;
// no LLM participates. This structural spec asserts libs/examination
// imports no LLM/ai-draft/anthropic substrate, keeping the boundary honest
// as the Job-Module PR adds the JD-generation consumer (libs/requisition)
// next door.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('Job-Module G6 — no-LLM-boundary (libs/examination stays deterministic)', () => {
  it('libs/examination contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('libs/examination module has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/examination.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
