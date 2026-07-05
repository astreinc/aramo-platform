import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// Promotion Gate Slice-B1 — the no-LLM-boundary structural spec (ADR-0015
// Decision 10). The reconcile projection is DETERMINISTIC: it maps the newest
// declared EvidenceRecord values into the flat TalentRecord (fill-null + union-
// append) — no inference, no LLM. It MUST NOT import @aramo/ai-draft,
// @anthropic-ai/sdk, DraftProvider, or any llm/anthropic identifier. Run via the
// lifted helper (@aramo/common) so this and the sibling poll specs share one
// source of truth.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('Promotion Gate Slice-B1 — no-LLM-boundary (ADR-0015 Decision 10, structural)', () => {
  it('libs/talent-reconcile contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('module file has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/talent-reconcile.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
