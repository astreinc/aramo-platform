// CI-B3 — thin persistence gateway for ConversationTranscript. Holds no domain
// rules (the service owns the state machine + authorization); it only reads and
// writes rows. NEVER selects or writes a transcript body (none exists — directive
// §7.1). All queries are tenant-scoped.

import { Injectable } from '@nestjs/common';

import type {
  TranscriptCustodyMode,
  TranscriptRecordingDependency,
  TranscriptSourceType,
  TranscriptState,
} from './domain/transcript-enums.js';
import { PrismaService } from './prisma/prisma.service.js';

/** Provider-neutral view of a persisted transcript aggregate (no body). */
export interface ConversationTranscriptRow {
  id: string;
  tenant_id: string;
  interaction_id: string;
  provider_key: string;
  provider_transcript_id: string;
  provider_resource_ref: string | null;
  source_type: TranscriptSourceType;
  recording_dependency: TranscriptRecordingDependency;
  language: string | null;
  speaker_attribution_supported: boolean | null;
  timestamps_supported: boolean | null;
  state: TranscriptState;
  custody_mode: TranscriptCustodyMode;
  source_artifact_ref: string | null;
  source_sha256: string | null;
  normalized_artifact_ref: string | null;
  normalized_sha256: string | null;
  // CI-B4 — which normalization contract minted the normalized artifact.
  normalization_schema_version: string | null;
  retention_policy_ref: string | null;
  expires_at: Date | null;
  deleted_at: Date | null;
  // CI-B4 — NORMALIZED artifact deletion marker (independent of source deleted_at).
  normalized_deleted_at: Date | null;
  attempt_count: number;
  last_error_code: string | null;
  // CI-B4 — normalization-phase bounded-retry counter (separate from acquisition).
  normalization_attempt_count: number;
  provider_generated_at: Date | null;
  source_available_at: Date | null;
  acquired_at: Date | null;
  normalized_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Fields set when an aggregate is first opened from an availability signal. */
export interface OpenTranscriptRow {
  tenant_id: string;
  interaction_id: string;
  provider_key: string;
  provider_transcript_id: string;
  provider_resource_ref?: string | null;
  source_type?: TranscriptSourceType;
  recording_dependency?: TranscriptRecordingDependency;
  language?: string | null;
  speaker_attribution_supported?: boolean | null;
  timestamps_supported?: boolean | null;
  custody_mode?: TranscriptCustodyMode;
  state: TranscriptState;
  provider_generated_at?: Date | null;
  source_available_at?: Date | null;
  retention_policy_ref?: string | null;
  expires_at?: Date | null;
}

/** Arbitrary column patch (state transitions + acquisition results). */
export type TranscriptPatch = Partial<
  Omit<
    ConversationTranscriptRow,
    'id' | 'tenant_id' | 'provider_key' | 'provider_transcript_id' | 'created_at'
  >
>;

@Injectable()
export class ConversationTranscriptRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent open: insert-if-absent keyed by the unique
   * (tenant_id, provider_key, provider_transcript_id). Replay of the same
   * availability signal returns the existing row unchanged (directive §27).
   */
  async openIfAbsent(input: OpenTranscriptRow): Promise<ConversationTranscriptRow> {
    const row = await this.prisma.conversationTranscript.upsert({
      where: {
        tenant_id_provider_key_provider_transcript_id: {
          tenant_id: input.tenant_id,
          provider_key: input.provider_key,
          provider_transcript_id: input.provider_transcript_id,
        },
      },
      // Convergent replay — never mutate an existing aggregate on re-signal.
      update: {},
      create: {
        tenant_id: input.tenant_id,
        interaction_id: input.interaction_id,
        provider_key: input.provider_key,
        provider_transcript_id: input.provider_transcript_id,
        provider_resource_ref: input.provider_resource_ref ?? null,
        source_type: input.source_type ?? 'unknown',
        recording_dependency: input.recording_dependency ?? 'unknown',
        language: input.language ?? null,
        speaker_attribution_supported: input.speaker_attribution_supported ?? null,
        timestamps_supported: input.timestamps_supported ?? null,
        custody_mode: input.custody_mode ?? 'provider_referenced',
        state: input.state,
        provider_generated_at: input.provider_generated_at ?? null,
        source_available_at: input.source_available_at ?? null,
        retention_policy_ref: input.retention_policy_ref ?? null,
        expires_at: input.expires_at ?? null,
      },
    });
    return row as ConversationTranscriptRow;
  }

  async findByProviderRef(
    tenantId: string,
    providerKey: string,
    providerTranscriptId: string,
  ): Promise<ConversationTranscriptRow | null> {
    const row = await this.prisma.conversationTranscript.findUnique({
      where: {
        tenant_id_provider_key_provider_transcript_id: {
          tenant_id: tenantId,
          provider_key: providerKey,
          provider_transcript_id: providerTranscriptId,
        },
      },
    });
    return (row as ConversationTranscriptRow) ?? null;
  }

  /** Tenant-scoped fetch by id (returns null for a wrong-tenant id). */
  async findByIdInTenant(
    tenantId: string,
    id: string,
  ): Promise<ConversationTranscriptRow | null> {
    const row = await this.prisma.conversationTranscript.findFirst({
      where: { id, tenant_id: tenantId },
    });
    return (row as ConversationTranscriptRow) ?? null;
  }

  /** Tenant-scoped patch. Returns the updated row. */
  async patchInTenant(
    tenantId: string,
    id: string,
    patch: TranscriptPatch,
  ): Promise<ConversationTranscriptRow> {
    const result = await this.prisma.conversationTranscript.updateMany({
      where: { id, tenant_id: tenantId },
      data: patch,
    });
    if (result.count === 0) {
      throw new Error('ConversationTranscript not found in tenant for patch');
    }
    const row = await this.findByIdInTenant(tenantId, id);
    // Non-null: updateMany matched exactly one row above.
    return row as ConversationTranscriptRow;
  }
}
