import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertModuleHasNoLlmImports,
  findNoLlmBoundaryViolations,
} from '@aramo/common';

// Cold-Ingest Extraction — THE no-LLM-boundary structural spec (ADR-0015
// Decision 10). AI/LLM provider consumption is confined to libs/ai-draft and
// its declared consumers. This poll re-reads a résumé with the DETERMINISTIC
// parser (resume-parse — pdf-parse / mammoth heuristics, no LLM) and writes the
// parsed fields as declared evidence. It MUST NOT import @aramo/ai-draft,
// @anthropic-ai/sdk, DraftProvider, or any llm/LLM/anthropic identifier.
//
// Run via the lifted helper (@aramo/common) so this spec and the
// libs/resume-parse / libs/import / libs/matching twins share one source of
// truth for what "no LLM" structurally means — they cannot drift.

const LIB_ROOT = resolve(__dirname, '..', '..');

describe('Cold-Ingest Extraction — no-LLM-boundary (ADR-0015 Decision 10, structural)', () => {
  it('libs/cold-ingest-extraction contains no LLM/ai-draft/anthropic import or identifier', () => {
    const violations = findNoLlmBoundaryViolations(LIB_ROOT, {
      // Exclude THIS spec — it legitimately names the forbidden tokens.
      excludeBasenames: ['no-llm-boundary.spec.ts'],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('module file has no dependency on @aramo/ai-draft or @anthropic-ai/sdk', () => {
    const moduleFile = readFileSync(
      resolve(LIB_ROOT, 'src/lib/cold-ingest-extraction.module.ts'),
      'utf8',
    );
    expect(() => assertModuleHasNoLlmImports(moduleFile)).not.toThrow();
  });
});
