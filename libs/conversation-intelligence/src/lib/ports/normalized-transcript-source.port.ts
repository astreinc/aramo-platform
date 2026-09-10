// CI-B6 — the normalized-transcript read seam. The lib consumes a MINIMAL,
// provider-neutral view; the composition root binds a concrete adapter that
// reads the B4 normalized artifact (TRANSCRIPT_ARTIFACT_STORE.getSource), VERIFIES
// the normalized_sha256, parses + validates it (validateNormalizedTranscript),
// and hands over this view. This keeps conversation-intelligence free of a
// @aramo/conversation-transcript nx edge and free of any Zoom/provider detail.

/** A minimal canonical utterance (subset of B4 NormalizedUtterance). */
export interface NormalizedTranscriptUtteranceView {
  readonly utterance_id: string;
  readonly ordinal: number;
  readonly speaker_role: string;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly text: string;
}

/** Minimal normalized-transcript view B6 grounds against. */
export interface NormalizedTranscriptView {
  readonly conversation_transcript_id: string;
  readonly tenant_id: string;
  readonly interaction_id: string;
  /** The exact normalized-artifact hash (verified by the adapter before return). */
  readonly normalized_sha256: string;
  readonly language?: string;
  readonly utterances: readonly NormalizedTranscriptUtteranceView[];
}

/** Transcript metadata sufficient to record a terminal run when grounding fails. */
export interface TranscriptGroundingMeta {
  readonly interaction_id: string;
  readonly normalized_sha256: string;
}

/**
 * Discriminated load outcome — the adapter never throws content into the service.
 * `artifact_not_found`/`hash_mismatch` carry the row meta so the service can
 * record a terminal run (with no model call); `not_found`/`not_ready` produce no
 * run at all.
 */
export type NormalizedTranscriptLoadResult =
  | { readonly status: 'ready'; readonly view: NormalizedTranscriptView }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_ready' }
  | { readonly status: 'artifact_not_found'; readonly meta: TranscriptGroundingMeta }
  | { readonly status: 'hash_mismatch'; readonly meta: TranscriptGroundingMeta };

export interface NormalizedTranscriptSource {
  /** Load + verify the normalized transcript for a tenant-scoped transcript id. */
  load(tenantId: string, conversationTranscriptId: string): Promise<NormalizedTranscriptLoadResult>;
}

export const NORMALIZED_TRANSCRIPT_SOURCE = 'CI_NORMALIZED_TRANSCRIPT_SOURCE';
