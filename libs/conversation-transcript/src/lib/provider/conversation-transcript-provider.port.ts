// CI-B3 — the conversation-transcript-OWNED provider-neutral acquisition port
// (directive §5). This is the contract the later provider adapter seams
// (CI-B5Z / CI-B5M) will implement. NO vendor type, field name, provider event
// payload, or auth detail appears in this file — provider-specific names
// terminate at the adapter boundary. B3 ships NO real adapter (only a test fake).
//
// The port confines the raw provider transcript body OUTSIDE the domain: an
// adapter streams source content to encrypted object storage and returns an
// OPAQUE artifact handle (ref + hash + optional byte length) — never a body,
// so no transcript text can leak into memory, logs, traces, or errors
// (directive §7.1/§17/§28/§30.1).

import type {
  TranscriptRecordingDependency,
  TranscriptSourceType,
} from '../domain/transcript-enums.js';

/**
 * Provider-neutral capability declaration (directive §5). This is DECLARATION
 * only — B3 proves nothing about any real provider. `recording_dependency` is
 * PROVIDER-DECLARED and may differ per provider (directive §4.3/§6.2/§30.20);
 * B3 must never globally assert transcription-without-recording support.
 */
export interface TranscriptCapabilities {
  /** Full post-conversation transcript retrievable via a supported API. */
  readonly full_post_conversation_transcript: boolean;
  /** Live/streaming transcript (CI-B9 concern; declared, never implemented in B3). */
  readonly live_transcript_stream: boolean;
  readonly speaker_attribution: boolean;
  readonly timestamps: boolean;
  readonly confidence_values: boolean;
  /** Provider declares a transcript language. */
  readonly transcript_language: boolean;
  readonly custom_vocabulary: boolean;
  /** Provider performs its own redaction before Aramo acquisition. */
  readonly provider_side_redaction: boolean;
  /** Whether an eligible full transcript requires cloud recording (per provider). */
  readonly recording_dependency: TranscriptRecordingDependency;
  /** Provider retains the transcript resource for some window. */
  readonly provider_transcript_retention: boolean;
  /** Provider emits a transcript-availability event. */
  readonly transcript_availability_event: boolean;
}

/**
 * A provider-neutral reference to a provider transcript resource, resolved from
 * a provider-neutral availability signal by {@link ConversationTranscriptProvider.resolveTranscriptReference}.
 */
export interface ProviderTranscriptReference {
  readonly provider_transcript_id: string;
  /** Optional opaque provider reference/URL — never a token or secret. */
  readonly provider_resource_ref?: string;
}

/**
 * The provider-neutral, already-authorized acquisition command. The composition
 * root constructs this AFTER proving transcription authority via the Consent
 * authority (directive §4) — B3 never evaluates consent itself.
 */
export interface AcquireTranscriptProviderInput {
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly provider_transcript_id: string;
  readonly provider_resource_ref?: string;
}

/**
 * The provider-neutral acquisition RESULT. Carries an OPAQUE source artifact
 * handle (the adapter has already persisted the body to encrypted object
 * storage) — NEVER the transcript body. Integrity + capability + provenance
 * metadata only.
 */
export interface TranscriptAcquisitionResult {
  readonly provider_transcript_id: string;
  readonly source_type: TranscriptSourceType;
  /** Opaque object-storage handle for the source artifact (bare key, no URL). */
  readonly source_artifact_ref: string;
  /** SHA-256 (hex) of the source artifact — integrity metadata only. */
  readonly source_sha256: string;
  /** Byte length of the source artifact, if known (metadata only). */
  readonly source_byte_length?: number;
  readonly language?: string;
  readonly speaker_attribution_supported?: boolean;
  readonly timestamps_supported?: boolean;
  readonly recording_dependency?: TranscriptRecordingDependency;
  readonly provider_generated_at?: Date;
  /** Provider retention hint (opaque token/reference), if declared. */
  readonly provider_retention_hint?: string;
}

/**
 * Discriminated acquisition outcome. Retryable vs terminal failures are
 * distinguishable so the service can advance to `failed_retryable` (bounded
 * retry) vs `failed_terminal` (directive §20). `error_code` is a taxonomy token,
 * NEVER raw provider text (directive §17/§28 — no transcript content in errors).
 */
export type TranscriptAcquisitionOutcome =
  | { readonly kind: 'acquired'; readonly result: TranscriptAcquisitionResult }
  | { readonly kind: 'retryable_failure'; readonly error_code: string }
  | { readonly kind: 'terminal_failure'; readonly error_code: string };

/**
 * The provider-neutral transcript acquisition contract. A concrete adapter
 * (registered in a later seam) confines all vendor terminology behind this port.
 */
export interface ConversationTranscriptProvider {
  /** Normalized lowercase provider key (e.g. matches the registry key). */
  providerKey(): string;
  /** Capability declaration for this provider (declaration only). */
  getCapabilities(): TranscriptCapabilities;
  /** Map a provider-neutral availability signal to a transcript reference. */
  resolveTranscriptReference(event: unknown): ProviderTranscriptReference;
  /**
   * Acquire the source transcript: the adapter fetches the provider transcript,
   * streams the body to encrypted object storage, and returns an opaque handle.
   * MUST be idempotent for the same provider transcript id.
   */
  acquireTranscript(
    input: AcquireTranscriptProviderInput,
  ): Promise<TranscriptAcquisitionOutcome>;
}

/** DI token — the concrete provider adapter/registry is bound at composition root. */
export const CONVERSATION_TRANSCRIPT_PROVIDER = 'CONVERSATION_TRANSCRIPT_PROVIDER';
