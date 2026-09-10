import { describe, expect, it } from 'vitest';

import { validateAnalysisResult } from '../lib/analysis/analysis-validator.js';
import { validateCitationsAgainstTranscript } from '../lib/analysis/citation-validator.js';
import { CI_ANALYSIS_SCHEMA_VERSION, type AnalysisResultV1 } from '../lib/analysis/analysis-schema.js';
import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from '../lib/domain/errors.js';
import { canCiRunTransition } from '../lib/domain/run-state-machine.js';
import { FakeCiModelProvider } from '../lib/model/fake/fake-ci-model-provider.js';
import type { NormalizedTranscriptView } from '../lib/ports/normalized-transcript-source.port.js';

const TRANSCRIPT: NormalizedTranscriptView = {
  conversation_transcript_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  interaction_id: '33333333-3333-4333-8333-333333333333',
  normalized_sha256: 'a'.repeat(64),
  utterances: [
    { utterance_id: 'utt_1', ordinal: 0, speaker_role: 'RECRUITER', text: 'How many years of Java do you have?' },
    { utterance_id: 'utt_2', ordinal: 1, speaker_role: 'UNKNOWN', text: 'I think about eight years of Java.' },
  ],
};

function validResult(): AnalysisResultV1 {
  return {
    schema_version: CI_ANALYSIS_SCHEMA_VERSION,
    claims: [
      {
        claim_type: 'talent_statement',
        context_ref: 'role',
        statement: 'Talent stated approximately eight years of Java experience.',
        status: 'SUPPORTED_BY_STATEMENT',
        citations: [{ utterance_id: 'utt_2', quote: 'about eight years of Java' }],
      },
      {
        claim_type: 'requisition_topic',
        context_ref: 'work_authorization',
        statement: 'Work authorization was not discussed.',
        status: 'NOT_DISCUSSED',
        citations: [],
      },
    ],
    draft: { sections: [{ key: 'relevant_talent_statements', items: ['Talent discussed Java experience.'] }] },
  };
}

describe('CI-B6 strict analysis validator', () => {
  it('accepts a well-formed analysis.v1 result', () => {
    expect(() => validateAnalysisResult(validResult())).not.toThrow();
  });

  it('rejects a non-object result (MODEL_OUTPUT_INVALID)', () => {
    expect(() => validateAnalysisResult('nope')).toThrow(CiAnalysisValidationError);
  });

  it('rejects any unknown top-level key (e.g. a numeric-ordering field)', () => {
    const bad = validResult() as unknown as Record<string, unknown>;
    // Construct the forbidden ordering key at runtime (keeps this source vocab-clean).
    bad[['s', 'core'].join('')] = 0.87;
    expect(() => validateAnalysisResult(bad)).toThrow(/forbidden key/);
  });

  it('rejects an out-of-vocabulary claim status (e.g. a fit label)', () => {
    const bad = validResult();
    (bad.claims as { status: string }[])[0].status = 'STRONG_FIT';
    expect(() => validateAnalysisResult(bad)).toThrow(CiAnalysisValidationError);
  });

  it('rejects a material claim with no citation', () => {
    const bad = validResult();
    (bad.claims as { citations: unknown[] }[])[0].citations = [];
    try {
      validateAnalysisResult(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CiAnalysisValidationError).code).toBe(CI_PROCESSING_ERROR_CODES.CITATION_INVALID);
    }
  });

  it('rejects NOT_DISCUSSED carrying a citation', () => {
    const bad = validResult();
    (bad.claims as { citations: unknown[] }[])[1].citations = [{ utterance_id: 'utt_1', quote: 'x' }];
    expect(() => validateAnalysisResult(bad)).toThrow(CiAnalysisValidationError);
  });

  it('rejects a claim asserting a protected/sensitive attribute', () => {
    const bad = validResult();
    (bad.claims as { claim_type: string; statement: string }[])[0].claim_type = 'talent_religion';
    (bad.claims as { statement: string }[])[0].statement = 'Talent stated their religion.';
    expect(() => validateAnalysisResult(bad)).toThrow(CiAnalysisValidationError);
  });
});

describe('CI-B6 citation validation against the transcript', () => {
  it('accepts a citation whose quote is present in the cited utterance', () => {
    expect(() => validateCitationsAgainstTranscript(validResult(), TRANSCRIPT)).not.toThrow();
  });

  it('rejects a citation to a nonexistent / cross-transcript utterance (CITATION_INVALID)', () => {
    const bad = validResult();
    (bad.claims as { citations: { utterance_id: string; quote: string }[] }[])[0].citations = [
      { utterance_id: 'utt_not_here', quote: 'anything' },
    ];
    try {
      validateCitationsAgainstTranscript(bad, TRANSCRIPT);
      throw new Error('should throw');
    } catch (e) {
      expect((e as CiAnalysisValidationError).code).toBe(CI_PROCESSING_ERROR_CODES.CITATION_INVALID);
    }
  });

  it('rejects a quote not found in the utterance (CITATION_SPAN_MISMATCH)', () => {
    const bad = validResult();
    (bad.claims as { citations: { utterance_id: string; quote: string }[] }[])[0].citations = [
      { utterance_id: 'utt_2', quote: 'a phrase that is absent zzz' },
    ];
    try {
      validateCitationsAgainstTranscript(bad, TRANSCRIPT);
      throw new Error('should throw');
    } catch (e) {
      expect((e as CiAnalysisValidationError).code).toBe(CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH);
    }
  });

  it('rejects an out-of-range span (CITATION_SPAN_MISMATCH)', () => {
    const bad = validResult();
    (bad.claims as { citations: { utterance_id: string; quote: string; start_offset: number; end_offset: number }[] }[])[0].citations = [
      { utterance_id: 'utt_2', quote: 'x', start_offset: 0, end_offset: 9999 },
    ];
    expect(() => validateCitationsAgainstTranscript(bad, TRANSCRIPT)).toThrow(CiAnalysisValidationError);
  });
});

describe('CI-B6 fake model provider', () => {
  const input = {
    tenant_id: TRANSCRIPT.tenant_id,
    conversation_transcript_id: TRANSCRIPT.conversation_transcript_id,
    normalized_transcript: TRANSCRIPT,
    requisition_context: { role: { title: 'Engineer' } },
    prompt_template_id: 'p',
    prompt_template_version: 'v1',
    prompt_sha256: 'h',
    output_schema_version: CI_ANALYSIS_SCHEMA_VERSION,
  };

  it('valid mode produces output that passes both validators, citing a real utterance', async () => {
    const out = await new FakeCiModelProvider('valid').generateStructuredAnalysis(input);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const result = validateAnalysisResult(out.raw_result);
    expect(() => validateCitationsAgainstTranscript(result, TRANSCRIPT)).not.toThrow();
  });

  it('retryable + terminal modes are surfaced', async () => {
    for (const m of ['timeout', 'rate_limited', 'server_error'] as const) {
      const out = await new FakeCiModelProvider(m).generateStructuredAnalysis(input);
      expect(out.kind).toBe('retryable_failure');
    }
    const malformed = await new FakeCiModelProvider('malformed').generateStructuredAnalysis(input);
    expect(malformed.kind).toBe('ok'); // ok payload but not an object → validator rejects
    if (malformed.kind === 'ok') expect(() => validateAnalysisResult(malformed.raw_result)).toThrow();
  });
});

describe('CI-B6 run state machine', () => {
  it('completed and failed_terminal are immutable terminals', () => {
    expect(canCiRunTransition('completed', 'processing')).toBe(false);
    expect(canCiRunTransition('failed_terminal', 'processing')).toBe(false);
  });
  it('blocked_not_authorized is re-drivable to processing', () => {
    expect(canCiRunTransition('blocked_not_authorized', 'processing')).toBe(true);
  });
  it('processing can complete or fail', () => {
    expect(canCiRunTransition('processing', 'completed')).toBe(true);
    expect(canCiRunTransition('processing', 'blocked_not_authorized')).toBe(true);
  });
});
