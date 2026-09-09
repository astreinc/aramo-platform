// CI-B6 — the versioned structured-output contract (directive §12). The model
// MUST return ONLY this shape; a strict ALLOWLIST validator (analysis-validator)
// rejects any unknown key — which is how forbidden output (numeric ordering /
// fit metrics / hiring recommendations / confidence) is refused WITHOUT this
// module ever naming those banned concepts. No prose outside the schema becomes
// authoritative CI evidence.

import type { ConversationIntelligenceClaimStatus } from '../domain/run-enums.js';

export const CI_ANALYSIS_SCHEMA_VERSION = 'conversation-intelligence.analysis.v1';

/** A model-provided citation (validated against the transcript; NOT persisted verbatim). */
export interface AnalysisCitationV1 {
  readonly utterance_id: string;
  /** The excerpt the model claims — validated against transcript text, then DROPPED. */
  readonly quote: string;
  readonly start_offset?: number;
  readonly end_offset?: number;
}

export interface AnalysisClaimV1 {
  readonly claim_type: string;
  /** Stable immutable-snapshot context key where this grounds a requirement. */
  readonly context_ref?: string;
  readonly statement: string;
  readonly status: ConversationIntelligenceClaimStatus;
  readonly citations: readonly AnalysisCitationV1[];
}

/** A review-ready draft section (AI-generated summary lines; not approved). */
export interface AnalysisDraftSectionV1 {
  readonly key: string;
  readonly items: readonly string[];
}

export interface AnalysisDraftV1 {
  readonly sections: readonly AnalysisDraftSectionV1[];
}

export interface AnalysisResultV1 {
  readonly schema_version: string;
  readonly claims: readonly AnalysisClaimV1[];
  readonly draft: AnalysisDraftV1;
}

// ---- Strict allowlists (any key outside these → schema mismatch) ----
export const ANALYSIS_ALLOWED_TOP_KEYS = ['schema_version', 'claims', 'draft'] as const;
export const ANALYSIS_ALLOWED_CLAIM_KEYS = [
  'claim_type',
  'context_ref',
  'statement',
  'status',
  'citations',
] as const;
export const ANALYSIS_ALLOWED_CITATION_KEYS = [
  'utterance_id',
  'quote',
  'start_offset',
  'end_offset',
] as const;
export const ANALYSIS_ALLOWED_DRAFT_KEYS = ['sections'] as const;
export const ANALYSIS_ALLOWED_DRAFT_SECTION_KEYS = ['key', 'items'] as const;

/**
 * Protected/sensitive attribute markers (directive §17). A claim whose type or
 * statement asserts one of these is rejected — CI must not promote protected
 * traits into structured output.
 */
export const PROTECTED_TRAIT_MARKERS = [
  'race',
  'ethnicity',
  'religion',
  'religious',
  'disability',
  'disabled',
  'medical',
  'health condition',
  'sexual orientation',
  'pregnan',
  'political',
  'genetic',
  'national origin',
  'citizenship status',
] as const;
