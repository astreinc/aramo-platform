// CI-B3 — the provider-neutral transcript acquisition service. Owns the
// acquisition state machine, idempotent convergence, tenant-safe interaction
// linkage, and the fail-closed transcription-authorization seam. It NEVER:
//   * evaluates consent itself (directive §3.2/§4 — Consent is the sole
//     authority; the composition root supplies an already-authorized command);
//   * calls a real provider (directive §30.9 — only a registered adapter/fake);
//   * touches transcript CONTENT (no body ever enters this layer — §7.1/§17);
//   * normalizes utterances (that is CI-B4 — §14 of this executor scope).

import { Inject, Injectable } from '@nestjs/common';

import type {
  TranscriptCustodyMode,
  TranscriptRecordingDependency,
  TranscriptSourceType,
} from './domain/transcript-enums.js';
import {
  TranscriptAcquisitionNotAuthorizedError,
  TranscriptInteractionNotFoundError,
} from './domain/errors.js';
import { assertTranscriptTransition } from './domain/transcript-state-machine.js';
import {
  ConversationTranscriptRepository,
  type ConversationTranscriptRow,
} from './conversation-transcript.repository.js';
import {
  INTERACTION_REFERENCE_PORT,
  type InteractionReferencePort,
} from './ports/interaction-reference.port.js';
import {
  isTranscriptionAuthorized,
  type TranscriptionAuthorization,
} from './ports/transcription-authorization.js';
import { ConversationTranscriptProviderRegistry } from './provider/conversation-transcript-provider.registry.js';

/** Bounded retry budget before a transcript parks at intervention_required. */
export const MAX_ACQUISITION_ATTEMPTS = 5;

/** A provider-neutral transcript-availability signal (directive §19). */
export interface RegisterTranscriptAvailabilityCommand {
  readonly tenant_id: string;
  readonly interaction_id: string;
  readonly provider_key: string;
  readonly provider_transcript_id: string;
  readonly provider_resource_ref?: string;
  readonly source_type?: TranscriptSourceType;
  readonly recording_dependency?: TranscriptRecordingDependency;
  readonly language?: string;
  readonly speaker_attribution_supported?: boolean;
  readonly timestamps_supported?: boolean;
  readonly custody_mode?: TranscriptCustodyMode;
  readonly provider_generated_at?: Date;
  readonly retention_policy_ref?: string;
  readonly expires_at?: Date;
}

/**
 * An ALREADY-AUTHORIZED acquisition command (directive §4.5). The composition
 * root proves transcription authority via the Consent authority and stamps
 * `authorization` before calling. B3 fails closed when the proof is absent.
 */
export interface AcquireTranscriptCommand {
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly provider_transcript_id: string;
  readonly authorization: TranscriptionAuthorization;
  /** Custody applied when source content is durably held (directive §7.3). */
  readonly custody_mode?: TranscriptCustodyMode;
}

@Injectable()
export class ConversationTranscriptService {
  constructor(
    private readonly repo: ConversationTranscriptRepository,
    private readonly providers: ConversationTranscriptProviderRegistry,
    @Inject(INTERACTION_REFERENCE_PORT)
    private readonly interactions: InteractionReferencePort,
  ) {}

  /**
   * Idempotently open (or converge on) a transcript aggregate from a provider
   * availability signal. Enforces tenant-safe interaction linkage: a missing or
   * wrong-tenant interaction is rejected (directive §3.1/§28). Replay of the
   * same signal returns the existing aggregate unchanged (directive §27).
   */
  async registerTranscriptAvailability(
    command: RegisterTranscriptAvailabilityCommand,
  ): Promise<ConversationTranscriptRow> {
    const linked = await this.interactions.existsInTenant(
      command.tenant_id,
      command.interaction_id,
    );
    if (!linked) {
      throw new TranscriptInteractionNotFoundError(
        command.tenant_id,
        command.interaction_id,
      );
    }

    return this.repo.openIfAbsent({
      tenant_id: command.tenant_id,
      interaction_id: command.interaction_id,
      provider_key: command.provider_key,
      provider_transcript_id: command.provider_transcript_id,
      provider_resource_ref: command.provider_resource_ref ?? null,
      source_type: command.source_type ?? 'unknown',
      recording_dependency: command.recording_dependency ?? 'unknown',
      language: command.language ?? null,
      speaker_attribution_supported: command.speaker_attribution_supported ?? null,
      timestamps_supported: command.timestamps_supported ?? null,
      custody_mode: command.custody_mode ?? 'provider_referenced',
      state: 'source_available',
      provider_generated_at: command.provider_generated_at ?? null,
      source_available_at: command.provider_generated_at ?? new Date(),
      retention_policy_ref: command.retention_policy_ref ?? null,
      expires_at: command.expires_at ?? null,
    });
  }

  /**
   * Acquire the source transcript via the registered provider adapter. Gated on
   * an already-authorized command (fail-closed). Idempotent: a transcript that
   * has already reached `source_ready` converges without re-invoking the
   * provider or duplicating artifact metadata (directive §27). Retryable and
   * terminal provider failures are distinguished; bounded retries park at
   * `intervention_required` (directive §20).
   */
  async acquire(command: AcquireTranscriptCommand): Promise<ConversationTranscriptRow> {
    // Fail-closed authorization (directive §4.5). No proof => no acquisition,
    // no state change.
    if (!isTranscriptionAuthorized(command.authorization)) {
      throw new TranscriptAcquisitionNotAuthorizedError();
    }

    const existing = await this.repo.findByProviderRef(
      command.tenant_id,
      command.provider_key,
      command.provider_transcript_id,
    );
    if (existing === null) {
      throw new TranscriptInteractionNotFoundError(
        command.tenant_id,
        command.provider_transcript_id,
      );
    }

    // Idempotent convergence: already acquired => return as-is, do NOT re-call
    // the provider or re-write artifact metadata (directive §27).
    if (existing.state === 'source_ready') {
      return existing;
    }

    const provider = this.providers.get(command.provider_key);
    if (provider === undefined) {
      throw new Error(
        `No transcript provider registered for '${command.provider_key}'`,
      );
    }

    // Enter acquiring (explicit, asserted transition — directive §20).
    assertTranscriptTransition(existing.state, 'acquiring');
    await this.repo.patchInTenant(command.tenant_id, existing.id, {
      state: 'acquiring',
    });

    const outcome = await provider.acquireTranscript({
      tenant_id: command.tenant_id,
      provider_key: command.provider_key,
      provider_transcript_id: command.provider_transcript_id,
      provider_resource_ref: existing.provider_resource_ref ?? undefined,
    });

    if (outcome.kind === 'acquired') {
      const r = outcome.result;
      assertTranscriptTransition('acquiring', 'source_ready');
      return this.repo.patchInTenant(command.tenant_id, existing.id, {
        state: 'source_ready',
        source_type: r.source_type,
        source_artifact_ref: r.source_artifact_ref,
        source_sha256: r.source_sha256,
        language: r.language ?? existing.language,
        speaker_attribution_supported:
          r.speaker_attribution_supported ?? existing.speaker_attribution_supported,
        timestamps_supported: r.timestamps_supported ?? existing.timestamps_supported,
        recording_dependency: r.recording_dependency ?? existing.recording_dependency,
        provider_generated_at: r.provider_generated_at ?? existing.provider_generated_at,
        custody_mode: command.custody_mode ?? existing.custody_mode,
        acquired_at: new Date(),
        last_error_code: null,
      });
    }

    if (outcome.kind === 'retryable_failure') {
      const attempts = existing.attempt_count + 1;
      const park = attempts >= MAX_ACQUISITION_ATTEMPTS;
      const nextState = park ? 'intervention_required' : 'failed_retryable';
      assertTranscriptTransition('acquiring', nextState);
      return this.repo.patchInTenant(command.tenant_id, existing.id, {
        state: nextState,
        attempt_count: attempts,
        last_error_code: outcome.error_code,
      });
    }

    // terminal_failure
    assertTranscriptTransition('acquiring', 'failed_terminal');
    return this.repo.patchInTenant(command.tenant_id, existing.id, {
      state: 'failed_terminal',
      last_error_code: outcome.error_code,
    });
  }

  /** Expire a transcript (retention/expiry — directive §8.2). */
  async expire(tenantId: string, id: string): Promise<ConversationTranscriptRow> {
    const existing = await this.repo.findByIdInTenant(tenantId, id);
    if (existing === null) {
      throw new TranscriptInteractionNotFoundError(tenantId, id);
    }
    assertTranscriptTransition(existing.state, 'expired');
    return this.repo.patchInTenant(tenantId, id, {
      state: 'expired',
      expires_at: existing.expires_at ?? new Date(),
    });
  }

  /**
   * Mark the source ARTIFACT deleted without deleting the metadata aggregate
   * (directive §7.3/§8.2 — metadata/provenance may survive artifact deletion).
   * Clears the artifact ref/hash; the row and its provenance remain.
   */
  async markSourceArtifactDeleted(
    tenantId: string,
    id: string,
    deletedAt: Date = new Date(),
  ): Promise<ConversationTranscriptRow> {
    const existing = await this.repo.findByIdInTenant(tenantId, id);
    if (existing === null) {
      throw new TranscriptInteractionNotFoundError(tenantId, id);
    }
    return this.repo.patchInTenant(tenantId, id, {
      deleted_at: deletedAt,
      source_artifact_ref: null,
      source_sha256: null,
    });
  }
}
