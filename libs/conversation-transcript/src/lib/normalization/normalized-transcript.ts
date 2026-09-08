// CI-B4 — the versioned, provider-neutral CANONICAL normalized transcript
// contract (directive §9). This is the artifact CI-B6 will consume; downstream
// CI must consume THIS shape, never a provider-specific transcript shape. The
// canonical artifact is written to encrypted object storage; Postgres holds only
// its opaque ref + SHA-256. No vendor-specific field appears here.

import type { TranscriptSpeakerRole } from '../domain/transcript-enums.js';

import { sha256HexUtf8 } from './hashing.js';

/**
 * The frozen normalization schema version. A future breaking change to the
 * canonical shape, the utterance-id derivation, or the serializer REQUIRES a new
 * version string (directive §normalization-schema-version) — never a silent
 * change under this identifier.
 */
export const NORMALIZED_TRANSCRIPT_SCHEMA_VERSION =
  'conversation-transcript.normalized.v1';

/** A single canonical utterance (directive §9 minimum shape). */
export interface NormalizedUtterance {
  /** Deterministic, collision-resistant, stable across retries (see deriveUtteranceId). */
  readonly utterance_id: string;
  /** 0-based position in provider-supplied sequence order (never re-sorted). */
  readonly ordinal: number;
  readonly speaker_role: TranscriptSpeakerRole;
  /** Provider speaker id preserved verbatim where supplied (e.g. "1"). */
  readonly provider_speaker_id?: string;
  /** Provider speaker display label preserved where supplied. */
  readonly speaker_label?: string;
  /** Milliseconds from transcript/call start, where supplied. >= 0. */
  readonly start_ms?: number;
  /** Milliseconds from transcript/call start, where supplied. >= start_ms. */
  readonly end_ms?: number;
  /** Evidentiary utterance text (structural cleanup only — never rewritten). */
  readonly text: string;
}

/** The canonical normalized transcript (directive §9). */
export interface NormalizedTranscript {
  readonly schema_version: string;
  readonly transcript_id: string;
  readonly tenant_id: string;
  readonly interaction_id: string;
  readonly provider_key: string;
  readonly provider_transcript_id: string;
  /** SHA-256 of the SOURCE artifact this normalization was derived from. */
  readonly source_sha256: string;
  /** BCP-47 language tag, only where the provider declared it. */
  readonly language?: string;
  /** Provider-declared generation time (ISO 8601), only where supplied. */
  readonly generated_at?: string;
  readonly utterances: readonly NormalizedUtterance[];
}

/**
 * Derive a STABLE utterance id from canonical, deterministic inputs. The same
 * source under the same schema version yields the same id across retries; it is
 * NOT a random UUID and does NOT depend on DB insertion order. Provider segment
 * id + timestamps are folded in when present so that identical-text utterances
 * remain distinct.
 */
export function deriveUtteranceId(input: {
  schemaVersion: string;
  transcriptId: string;
  ordinal: number;
  providerSegmentId?: string;
  startMs?: number;
  endMs?: number;
  text: string;
}): string {
  // Structural, order-fixed pre-image via JSON encoding: each element is
  // self-delimiting (JSON string-escaping), so no delimiter can collide with
  // arbitrary provider segment ids or utterance text. Absent fields are encoded
  // as null (distinct from an empty string).
  const preimage = JSON.stringify([
    input.schemaVersion,
    input.transcriptId,
    input.ordinal,
    input.providerSegmentId ?? null,
    input.startMs ?? null,
    input.endMs ?? null,
    input.text,
  ]);
  return `utt_${sha256HexUtf8(preimage)}`;
}
