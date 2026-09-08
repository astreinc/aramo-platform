// CI-B4 — strict validator for normalized transcript v1 (directive §validation).
// Rejects malformed normalized data rather than silently accepting it. Error
// messages carry NO transcript text (directive §logging) — only structural
// facts (index, field name, taxonomy).

import {
  TRANSCRIPT_SPEAKER_ROLES,
  type TranscriptSpeakerRole,
} from '../domain/transcript-enums.js';

import { NormalizationSchemaInvalidError } from './normalization-errors.js';
import {
  NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
  type NormalizedTranscript,
} from './normalized-transcript.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SPEAKER_ROLE_SET = new Set<TranscriptSpeakerRole>(TRANSCRIPT_SPEAKER_ROLES);

function fail(detail: string): never {
  throw new NormalizationSchemaInvalidError(detail);
}

/**
 * Validate the canonical normalized transcript. Throws
 * {@link NormalizationSchemaInvalidError} on any violation; returns the
 * (narrowed) value on success.
 */
export function validateNormalizedTranscript(
  value: NormalizedTranscript,
): NormalizedTranscript {
  if (value.schema_version !== NORMALIZED_TRANSCRIPT_SCHEMA_VERSION) {
    fail(`schema_version must be ${NORMALIZED_TRANSCRIPT_SCHEMA_VERSION}`);
  }
  for (const idField of ['transcript_id', 'tenant_id', 'interaction_id'] as const) {
    if (!UUID_RE.test(String(value[idField]))) fail(`${idField} must be a UUID`);
  }
  if (typeof value.provider_key !== 'string' || value.provider_key.length === 0) {
    fail('provider_key must be a non-empty string');
  }
  if (
    typeof value.provider_transcript_id !== 'string' ||
    value.provider_transcript_id.length === 0
  ) {
    fail('provider_transcript_id must be a non-empty string');
  }
  if (!SHA256_RE.test(String(value.source_sha256))) {
    fail('source_sha256 must be a hex sha-256');
  }
  if (value.language !== undefined && typeof value.language !== 'string') {
    fail('language, when present, must be a string');
  }
  if (value.generated_at !== undefined && typeof value.generated_at !== 'string') {
    fail('generated_at, when present, must be an ISO string');
  }
  if (!Array.isArray(value.utterances)) fail('utterances must be an array');

  const seenIds = new Set<string>();
  value.utterances.forEach((u, i) => {
    if (u.ordinal !== i) fail(`utterance[${i}] ordinal must equal its index`);
    if (typeof u.utterance_id !== 'string' || u.utterance_id.length === 0) {
      fail(`utterance[${i}] utterance_id missing`);
    }
    if (seenIds.has(u.utterance_id)) fail(`utterance[${i}] utterance_id not unique`);
    seenIds.add(u.utterance_id);
    if (!SPEAKER_ROLE_SET.has(u.speaker_role)) {
      fail(`utterance[${i}] speaker_role outside closed vocabulary`);
    }
    if (typeof u.text !== 'string') fail(`utterance[${i}] text must be a string`);
    if (u.start_ms !== undefined) {
      if (!Number.isFinite(u.start_ms) || u.start_ms < 0) {
        fail(`utterance[${i}] start_ms must be >= 0`);
      }
    }
    if (u.end_ms !== undefined) {
      if (!Number.isFinite(u.end_ms)) fail(`utterance[${i}] end_ms must be finite`);
      if (u.start_ms !== undefined && u.end_ms < u.start_ms) {
        fail(`utterance[${i}] end_ms must be >= start_ms`);
      }
    }
    if (
      u.provider_speaker_id !== undefined &&
      typeof u.provider_speaker_id !== 'string'
    ) {
      fail(`utterance[${i}] provider_speaker_id must be a string`);
    }
    if (u.speaker_label !== undefined && typeof u.speaker_label !== 'string') {
      fail(`utterance[${i}] speaker_label must be a string`);
    }
  });

  return value;
}
