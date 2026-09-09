// CI-B6 — the production normalized-transcript read adapter. Reads the B4
// ConversationTranscript row + normalized artifact, VERIFIES the normalized_sha256
// against the stored bytes, parses + validates the canonical v1 transcript, and
// returns a minimal provider-neutral view. Keeps @aramo/conversation-transcript
// coupling (and any provider detail) at the composition root. Never logs content.

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  ConversationTranscriptRepository,
  sha256Hex,
  validateNormalizedTranscript,
  type NormalizedTranscript,
} from '@aramo/conversation-transcript';
import { ObjectStorageService } from '@aramo/object-storage';
import type {
  NormalizedTranscriptLoadResult,
  NormalizedTranscriptSource,
  NormalizedTranscriptView,
} from '@aramo/conversation-intelligence';

const CI_NORMALIZED_MAX_BYTES = 16 * 1024 * 1024;

@Injectable()
export class ObjectStorageNormalizedTranscriptSource implements NormalizedTranscriptSource {
  constructor(
    private readonly transcripts: ConversationTranscriptRepository,
    private readonly storage: ObjectStorageService,
  ) {}

  async load(tenantId: string, conversationTranscriptId: string): Promise<NormalizedTranscriptLoadResult> {
    const row = await this.transcripts.findByIdInTenant(tenantId, conversationTranscriptId);
    if (row === null) return { status: 'not_found' };
    if (row.state !== 'normalized' || row.normalized_artifact_ref === null || row.normalized_sha256 === null) {
      return { status: 'not_ready' };
    }
    const meta = { interaction_id: row.interaction_id, normalized_sha256: row.normalized_sha256 };

    let bytes: Buffer;
    try {
      bytes = await this.storage.getObjectBytes({
        storage_key: row.normalized_artifact_ref,
        requestId: randomUUID(),
        maxBytes: CI_NORMALIZED_MAX_BYTES,
      });
    } catch {
      return { status: 'artifact_not_found', meta };
    }

    // Integrity: the exact stored bytes must hash to the recorded normalized_sha256.
    if (sha256Hex(bytes) !== row.normalized_sha256) {
      return { status: 'hash_mismatch', meta };
    }

    let parsed: NormalizedTranscript;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as NormalizedTranscript;
      validateNormalizedTranscript(parsed);
    } catch {
      // A malformed canonical artifact that nonetheless matched the hash is a
      // corruption of the stored evidence — treat as a grounding integrity fail.
      return { status: 'hash_mismatch', meta };
    }

    const view: NormalizedTranscriptView = {
      conversation_transcript_id: row.id,
      tenant_id: row.tenant_id,
      interaction_id: row.interaction_id,
      normalized_sha256: row.normalized_sha256,
      ...(parsed.language !== undefined ? { language: parsed.language } : {}),
      utterances: parsed.utterances.map((u) => ({
        utterance_id: u.utterance_id,
        ordinal: u.ordinal,
        speaker_role: u.speaker_role,
        ...(u.start_ms !== undefined ? { start_ms: u.start_ms } : {}),
        ...(u.end_ms !== undefined ? { end_ms: u.end_ms } : {}),
        text: u.text,
      })),
    };
    return { status: 'ready', view };
  }
}
