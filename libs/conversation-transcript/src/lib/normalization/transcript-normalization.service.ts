// CI-B4 — the deterministic canonical normalization service. Consumes the B3
// SOURCE artifact and produces the canonical NORMALIZED artifact
// (source_ready → normalizing → normalized). It NEVER: invokes AI, calls a real
// provider, summarizes/rewrites transcript text, fabricates speakers/timestamps,
// or writes transcript CONTENT into Postgres (directive §19-27, §30). Content
// lives in encrypted object storage; Postgres holds only refs/hashes/state.

import { Inject, Injectable } from '@nestjs/common';

import {
  ConversationTranscriptRepository,
  type ConversationTranscriptRow,
} from '../conversation-transcript.repository.js';
import {
  TranscriptInvalidStateError,
  TranscriptNotFoundError,
} from '../domain/errors.js';
import type { TranscriptSpeakerRole, TranscriptState } from '../domain/transcript-enums.js';
import { assertTranscriptTransition } from '../domain/transcript-state-machine.js';

import { canonicalBytes } from './canonical-json.js';
import { sha256Hex } from './hashing.js';
import {
  NormalizationError,
  SourceArtifactNotFoundError,
  SourceFormatUnsupportedError,
  SourceHashMismatchError,
  SourceParseFailedError,
  NormalizedArtifactWriteError,
} from './normalization-errors.js';
import {
  NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
  deriveUtteranceId,
  type NormalizedTranscript,
  type NormalizedUtterance,
} from './normalized-transcript.js';
import { validateNormalizedTranscript } from './normalized-transcript.validator.js';
import { normalizeUtteranceText } from './text-normalization.js';
import {
  TRANSCRIPT_ARTIFACT_STORE,
  TranscriptArtifactNotFoundError,
  TranscriptArtifactWriteError,
  type TranscriptArtifactStore,
} from './transcript-artifact-store.port.js';
import type { RawTranscriptSegment } from './transcript-source-parser.port.js';
import { TranscriptSourceParserRegistry } from './transcript-source-parser.registry.js';

/** Bounded normalization retry budget before parking at intervention. */
export const MAX_NORMALIZATION_ATTEMPTS = 5;

/** An already-scoped normalization command (directive §async flow). */
export interface NormalizeTranscriptCommand {
  readonly tenant_id: string;
  /** The ConversationTranscript aggregate id (tenant-scoped). */
  readonly transcript_id: string;
  /** Declared provider-neutral source format token (parser registry key). */
  readonly source_format: string;
}

/** States from which normalization may (re-)enter `normalizing`. */
const NORMALIZATION_ENTRY_STATES: ReadonlySet<TranscriptState> = new Set([
  'source_ready',
  'normalization_failed_retryable',
  'normalization_intervention_required',
]);

@Injectable()
export class TranscriptNormalizationService {
  constructor(
    private readonly repo: ConversationTranscriptRepository,
    private readonly parsers: TranscriptSourceParserRegistry,
    @Inject(TRANSCRIPT_ARTIFACT_STORE)
    private readonly store: TranscriptArtifactStore,
  ) {}

  /**
   * Deterministically normalize a transcript. Idempotent: an already-`normalized`
   * transcript converges without re-parsing or re-writing (stable utterance ids,
   * no duplicate artifact). Source-hash mismatch and parse/format failures fail
   * CLOSED (no normalized artifact). Retryable storage failures park after a
   * bounded number of attempts (directive §idempotency/§retry).
   */
  async normalize(command: NormalizeTranscriptCommand): Promise<ConversationTranscriptRow> {
    const existing = await this.repo.findByIdInTenant(command.tenant_id, command.transcript_id);
    if (existing === null) {
      throw new TranscriptNotFoundError(command.tenant_id, command.transcript_id);
    }

    // Idempotent convergence — already normalized: return as-is (directive §27).
    if (existing.state === 'normalized') return existing;

    // Enter `normalizing` from a valid entry state (asserted transition). A
    // re-entry that is already `normalizing` (crash recovery) proceeds as-is.
    if (existing.state !== 'normalizing') {
      if (!NORMALIZATION_ENTRY_STATES.has(existing.state)) {
        // Not a legal normalization entry — surface as an explicit state error.
        assertTranscriptTransition(existing.state, 'normalizing');
        throw new TranscriptInvalidStateError(existing.state, 'normalizing');
      }
      assertTranscriptTransition(existing.state, 'normalizing');
      await this.repo.patchInTenant(command.tenant_id, existing.id, { state: 'normalizing' });
    }

    try {
      const row = await this.runNormalization(command, existing);
      return row;
    } catch (err) {
      if (err instanceof NormalizationError) {
        return this.recordFailure(command.tenant_id, existing.id, existing.normalization_attempt_count, err);
      }
      throw err;
    }
  }

  private async runNormalization(
    command: NormalizeTranscriptCommand,
    existing: ConversationTranscriptRow,
  ): Promise<ConversationTranscriptRow> {
    if (existing.source_artifact_ref === null) {
      throw new SourceArtifactNotFoundError();
    }

    // 1. Read SOURCE bytes through the opaque, tenant-scoped store.
    let sourceBytes: Buffer;
    try {
      sourceBytes = await this.store.getSource(command.tenant_id, existing.source_artifact_ref);
    } catch (e) {
      if (e instanceof TranscriptArtifactNotFoundError) throw new SourceArtifactNotFoundError();
      throw e;
    }

    // 2. Verify SOURCE integrity — fail closed on mismatch (no normalized write).
    if (existing.source_sha256 !== null && sha256Hex(sourceBytes) !== existing.source_sha256) {
      throw new SourceHashMismatchError();
    }

    // 3. Parse via the provider-neutral parser seam.
    const parser = this.parsers.get(command.source_format);
    if (parser === undefined) throw new SourceFormatUnsupportedError();
    let parsed;
    try {
      parsed = parser.parse(sourceBytes);
    } catch {
      // Never surface raw parser output (may contain transcript text).
      throw new SourceParseFailedError();
    }

    // 4. Build canonical utterances (preserve; never fabricate).
    const utterances: NormalizedUtterance[] = parsed.segments.map((seg, ordinal) =>
      this.toUtterance(existing.id, ordinal, seg),
    );

    // 5. Assemble the canonical normalized transcript (only-present optionals).
    const language = parsed.language ?? existing.language ?? undefined;
    const generatedAt = existing.provider_generated_at
      ? existing.provider_generated_at.toISOString()
      : undefined;
    const normalized: NormalizedTranscript = {
      schema_version: NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
      transcript_id: existing.id,
      tenant_id: existing.tenant_id,
      interaction_id: existing.interaction_id,
      provider_key: existing.provider_key,
      provider_transcript_id: existing.provider_transcript_id,
      source_sha256: existing.source_sha256 ?? sha256Hex(sourceBytes),
      ...(language !== undefined ? { language } : {}),
      ...(generatedAt !== undefined ? { generated_at: generatedAt } : {}),
      utterances,
    };

    // 6. Strict validation (throws NormalizationSchemaInvalidError).
    validateNormalizedTranscript(normalized);

    // 7. Deterministic canonical serialization + hash of the EXACT bytes stored.
    const bytes = canonicalBytes(normalized);
    const normalizedSha256 = sha256Hex(bytes);

    // 8. Write the normalized artifact (retryable failures classified by store).
    let ref: string;
    try {
      ({ ref } = await this.store.putNormalized({
        tenant_id: command.tenant_id,
        transcript_id: existing.id,
        bytes,
      }));
    } catch (e) {
      if (e instanceof TranscriptArtifactWriteError) {
        throw new NormalizedArtifactWriteError(e.retryable);
      }
      throw e;
    }

    // 9. Persist normalized metadata + advance to `normalized`.
    assertTranscriptTransition('normalizing', 'normalized');
    return this.repo.patchInTenant(command.tenant_id, existing.id, {
      state: 'normalized',
      normalized_artifact_ref: ref,
      normalized_sha256: normalizedSha256,
      normalized_at: new Date(),
      normalization_schema_version: NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
      normalized_deleted_at: null,
      last_error_code: null,
    });
  }

  private toUtterance(
    transcriptId: string,
    ordinal: number,
    seg: RawTranscriptSegment,
  ): NormalizedUtterance {
    const text = normalizeUtteranceText(seg.text);
    // No inference: a role is UNKNOWN unless the source carried a reliable one.
    const speakerRole: TranscriptSpeakerRole = seg.speaker_role_hint ?? 'UNKNOWN';
    const utteranceId = deriveUtteranceId({
      schemaVersion: NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
      transcriptId,
      ordinal,
      providerSegmentId: seg.provider_segment_id,
      startMs: seg.start_ms,
      endMs: seg.end_ms,
      text,
    });
    return {
      utterance_id: utteranceId,
      ordinal,
      speaker_role: speakerRole,
      ...(seg.provider_speaker_id !== undefined ? { provider_speaker_id: seg.provider_speaker_id } : {}),
      ...(seg.speaker_label !== undefined ? { speaker_label: seg.speaker_label } : {}),
      ...(seg.start_ms !== undefined ? { start_ms: seg.start_ms } : {}),
      ...(seg.end_ms !== undefined ? { end_ms: seg.end_ms } : {}),
      text,
    };
  }

  private async recordFailure(
    tenantId: string,
    id: string,
    priorAttempts: number,
    err: NormalizationError,
  ): Promise<ConversationTranscriptRow> {
    let nextState: TranscriptState;
    const patch: Record<string, unknown> = { last_error_code: err.code };
    if (err.retryable) {
      const attempts = priorAttempts + 1;
      patch['normalization_attempt_count'] = attempts;
      nextState =
        attempts >= MAX_NORMALIZATION_ATTEMPTS
          ? 'normalization_intervention_required'
          : 'normalization_failed_retryable';
    } else {
      nextState = 'normalization_failed_terminal';
    }
    assertTranscriptTransition('normalizing', nextState);
    patch['state'] = nextState;
    return this.repo.patchInTenant(tenantId, id, patch);
  }

  /**
   * Delete the NORMALIZED artifact + mark its deletion, leaving the SOURCE
   * artifact and metadata untouched (directive §8.2 — independent lifecycles).
   */
  async deleteNormalizedArtifact(
    tenantId: string,
    id: string,
    deletedAt: Date = new Date(),
  ): Promise<ConversationTranscriptRow> {
    const existing = await this.repo.findByIdInTenant(tenantId, id);
    if (existing === null) throw new TranscriptNotFoundError(tenantId, id);
    if (existing.normalized_artifact_ref !== null) {
      await this.store.deleteNormalized(tenantId, existing.normalized_artifact_ref);
    }
    return this.repo.patchInTenant(tenantId, id, {
      normalized_deleted_at: deletedAt,
      normalized_artifact_ref: null,
      normalized_sha256: null,
    });
  }

  /**
   * Delete the SOURCE artifact + mark its deletion (store + metadata), leaving
   * the NORMALIZED artifact and its provenance independently valid (directive
   * §8.2 / test: source deletion after normalization).
   */
  async deleteSourceArtifact(
    tenantId: string,
    id: string,
    deletedAt: Date = new Date(),
  ): Promise<ConversationTranscriptRow> {
    const existing = await this.repo.findByIdInTenant(tenantId, id);
    if (existing === null) throw new TranscriptNotFoundError(tenantId, id);
    if (existing.source_artifact_ref !== null) {
      await this.store.deleteSource(tenantId, existing.source_artifact_ref);
    }
    return this.repo.patchInTenant(tenantId, id, {
      deleted_at: deletedAt,
      source_artifact_ref: null,
      source_sha256: null,
    });
  }
}
