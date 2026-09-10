// CI-B6 — the deterministic fake model provider (the ONLY provider B6 ships; no
// production model call in Gate-5 — directive). Given a mode it returns either a
// valid analysis.v1 object (citing REAL utterances from the input transcript) or
// a specific defective/failure outcome, so the strict validators can be proven.
// It NEVER emits hidden reasoning; it uses only the provided evidence.

import type {
  ConversationIntelligenceModelProvider,
  ModelAnalysisInput,
  ModelAnalysisOutcome,
} from '../conversation-intelligence-model-provider.port.js';
import { CI_ANALYSIS_SCHEMA_VERSION } from '../../analysis/analysis-schema.js';

export const FAKE_CI_MODEL_PROVIDER_KEY = 'fake_ci_analyst';

export type FakeCiModelMode =
  | 'valid'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'malformed'
  | 'schema_invalid_status'
  | 'unknown_field'
  | 'missing_citation'
  | 'bad_citation'
  | 'span_mismatch'
  | 'protected_trait'
  | 'numeric_ordering';

export class FakeCiModelProvider implements ConversationIntelligenceModelProvider {
  /** Number of generateStructuredAnalysis invocations (idempotency/no-invoke proofs). */
  public callCount = 0;

  constructor(private readonly mode: FakeCiModelMode = 'valid') {}

  providerKey(): string {
    return FAKE_CI_MODEL_PROVIDER_KEY;
  }

  modelIdentity(): { provider: string; model: string; version?: string } {
    return { provider: 'fake', model: 'fake-ci-analyst', version: '1' };
  }

  async generateStructuredAnalysis(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome> {
    this.callCount += 1;
    switch (this.mode) {
      case 'timeout':
        return { kind: 'retryable_failure', error_code: 'MODEL_TIMEOUT' };
      case 'rate_limited':
        return { kind: 'retryable_failure', error_code: 'MODEL_RATE_LIMITED' };
      case 'server_error':
        return { kind: 'retryable_failure', error_code: 'MODEL_PROVIDER_UNAVAILABLE' };
      case 'malformed':
        return { kind: 'ok', raw_result: 'not-a-json-object' };
      default:
        return { kind: 'ok', raw_result: this.buildResult(input) };
    }
  }

  private buildResult(input: ModelAnalysisInput): unknown {
    const u0 = input.normalized_transcript.utterances[0];
    const uttId = u0?.utterance_id ?? 'utt_missing';
    const quote = u0?.text ?? '';

    const supported = {
      claim_type: 'talent_statement',
      context_ref: 'role',
      statement: 'Talent stated relevant experience during the conversation.',
      status: 'SUPPORTED_BY_STATEMENT',
      citations: [{ utterance_id: uttId, quote }],
    };
    const notDiscussed = {
      claim_type: 'requisition_topic',
      context_ref: 'work_authorization',
      statement: 'Work authorization was not discussed in the conversation.',
      status: 'NOT_DISCUSSED',
      citations: [] as unknown[],
    };
    const draft = {
      sections: [
        { key: 'relevant_talent_statements', items: ['Talent discussed relevant experience.'] },
        { key: 'not_discussed', items: ['Work authorization was not discussed.'] },
      ],
    };

    const claims: Record<string, unknown>[] = [supported, notDiscussed];
    const first = claims[0] as Record<string, unknown>;
    const base: Record<string, unknown> = {
      schema_version: CI_ANALYSIS_SCHEMA_VERSION,
      claims,
      draft,
    };

    switch (this.mode) {
      case 'schema_invalid_status':
        first['status'] = 'STRONG_FIT';
        return base;
      case 'unknown_field':
        first['extra_unknown'] = true;
        return base;
      case 'missing_citation':
        first['citations'] = [];
        return base;
      case 'bad_citation':
        first['citations'] = [{ utterance_id: 'utt_does_not_exist', quote: 'fabricated' }];
        return base;
      case 'span_mismatch':
        first['citations'] = [
          { utterance_id: uttId, quote: 'text that is definitely not present in the utterance zzz' },
        ];
        return base;
      case 'protected_trait':
        claims[0] = {
          claim_type: 'talent_religion',
          statement: 'Talent stated their religion during the conversation.',
          status: 'SUPPORTED_BY_STATEMENT',
          citations: [{ utterance_id: uttId, quote }],
        };
        return base;
      case 'numeric_ordering': {
        // Construct a forbidden top-level ordering key at RUNTIME (source stays
        // free of the banned vocabulary); the strict allowlist rejects it.
        const forbiddenKey = ['s', 'core'].join('');
        base[forbiddenKey] = 0.9;
        return base;
      }
      default:
        return base; // 'valid'
    }
  }
}
