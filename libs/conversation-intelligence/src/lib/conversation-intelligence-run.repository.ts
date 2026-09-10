// CI-B6 — persistence for the immutable processing run + claims + citations +
// draft. Completion is a single transaction; thereafter the DB triggers make the
// run (terminal) and all claims/citations/drafts append-only. No transcript body
// and no raw model response are ever written.

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  ConversationIntelligenceClaimStatus,
  ConversationIntelligenceRunStatus,
} from './domain/run-enums.js';
import { PrismaService } from './prisma/prisma.service.js';

export interface CiRunRow {
  id: string;
  tenant_id: string;
  interaction_id: string;
  conversation_transcript_id: string;
  requisition_analysis_context_snapshot_id: string;
  normalized_sha256: string;
  model_provider: string;
  model_name: string;
  model_version: string | null;
  prompt_template_id: string;
  prompt_template_version: string;
  prompt_sha256: string;
  output_schema_version: string;
  status: ConversationIntelligenceRunStatus;
  attempt_count: number;
  last_error_code: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The analysis-identity key (the run's UNIQUE constraint). */
export interface CiAnalysisIdentity {
  tenant_id: string;
  conversation_transcript_id: string;
  requisition_analysis_context_snapshot_id: string;
  model_provider: string;
  model_name: string;
  prompt_template_version: string;
  output_schema_version: string;
}

export interface CiRunProvenance extends CiAnalysisIdentity {
  interaction_id: string;
  normalized_sha256: string;
  model_version: string | null;
  prompt_template_id: string;
  prompt_sha256: string;
}

export interface PersistClaimInput {
  ordinal: number;
  claim_type: string;
  context_ref: string | null;
  statement: string;
  status: ConversationIntelligenceClaimStatus;
  citations: {
    conversation_transcript_id: string;
    normalized_sha256: string;
    utterance_id: string;
    start_offset: number | null;
    end_offset: number | null;
  }[];
}

@Injectable()
export class ConversationIntelligenceRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAnalysisIdentity(key: CiAnalysisIdentity): Promise<CiRunRow | null> {
    const row = await this.prisma.conversationIntelligenceRun.findUnique({
      where: {
        analysis_identity: {
          tenant_id: key.tenant_id,
          conversation_transcript_id: key.conversation_transcript_id,
          requisition_analysis_context_snapshot_id: key.requisition_analysis_context_snapshot_id,
          model_provider: key.model_provider,
          model_name: key.model_name,
          prompt_template_version: key.prompt_template_version,
          output_schema_version: key.output_schema_version,
        },
      },
    });
    return (row as CiRunRow) ?? null;
  }

  async findRunByIdInTenant(tenantId: string, id: string): Promise<CiRunRow | null> {
    const row = await this.prisma.conversationIntelligenceRun.findFirst({
      where: { id, tenant_id: tenantId },
    });
    return (row as CiRunRow) ?? null;
  }

  /**
   * CI-B6P §19 — bounded, restart-safe recovery scan. Returns re-drivable runs
   * ({id, tenant_id} only) in `queued` or `failed_retryable` — the work a
   * reconciler should (re-)enqueue after a crash/restart or an enqueue-lost gap.
   * Cross-tenant (system sweep); ordered oldest-first; hard LIMIT (never an
   * unbounded scan). No transcript/model content is read.
   */
  async listReDrivableRuns(limit: number): Promise<{ id: string; tenant_id: string }[]> {
    const rows = await this.prisma.conversationIntelligenceRun.findMany({
      where: { status: { in: ['queued', 'failed_retryable'] } },
      select: { id: true, tenant_id: true },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, tenant_id: r.tenant_id }));
  }

  /** Create a queued run; on unique conflict (concurrent create) return the existing. */
  async createOrGetQueued(prov: CiRunProvenance): Promise<CiRunRow> {
    const existing = await this.findByAnalysisIdentity(prov);
    if (existing !== null) return existing;
    try {
      const row = await this.prisma.conversationIntelligenceRun.create({
        data: {
          id: randomUUID(),
          tenant_id: prov.tenant_id,
          interaction_id: prov.interaction_id,
          conversation_transcript_id: prov.conversation_transcript_id,
          requisition_analysis_context_snapshot_id: prov.requisition_analysis_context_snapshot_id,
          normalized_sha256: prov.normalized_sha256,
          model_provider: prov.model_provider,
          model_name: prov.model_name,
          model_version: prov.model_version,
          prompt_template_id: prov.prompt_template_id,
          prompt_template_version: prov.prompt_template_version,
          prompt_sha256: prov.prompt_sha256,
          output_schema_version: prov.output_schema_version,
          status: 'queued',
        },
      });
      return row as CiRunRow;
    } catch {
      const again = await this.findByAnalysisIdentity(prov);
      if (again !== null) return again;
      throw new Error('CI run create failed');
    }
  }

  /** Tenant-scoped status patch (pre-terminal transitions only; trigger blocks terminal). */
  async patchRun(
    tenantId: string,
    id: string,
    patch: Partial<Pick<CiRunRow, 'status' | 'attempt_count' | 'last_error_code' | 'started_at' | 'completed_at'>>,
  ): Promise<CiRunRow> {
    const res = await this.prisma.conversationIntelligenceRun.updateMany({
      where: { id, tenant_id: tenantId },
      data: patch,
    });
    if (res.count === 0) throw new Error('CI run not found in tenant for patch');
    return (await this.findRunByIdInTenant(tenantId, id)) as CiRunRow;
  }

  /**
   * Atomically complete the run: transition processing → completed, persist all
   * claims + citations + the draft. One transaction; immutable thereafter.
   */
  async completeRun(input: {
    tenantId: string;
    runId: string;
    claims: PersistClaimInput[];
    draftSchemaVersion: string;
    draftContent: unknown;
  }): Promise<CiRunRow> {
    await this.prisma.$transaction(async (tx) => {
      const upd = await tx.conversationIntelligenceRun.updateMany({
        where: { id: input.runId, tenant_id: input.tenantId, status: 'processing' },
        data: { status: 'completed', completed_at: new Date(), last_error_code: null },
      });
      if (upd.count === 0) throw new Error('CI run not in processing state for completion');

      for (const claim of input.claims) {
        const claimId = randomUUID();
        await tx.conversationIntelligenceClaim.create({
          data: {
            id: claimId,
            tenant_id: input.tenantId,
            run_id: input.runId,
            ordinal: claim.ordinal,
            claim_type: claim.claim_type,
            context_ref: claim.context_ref,
            statement: claim.statement,
            status: claim.status,
          },
        });
        for (const cit of claim.citations) {
          await tx.conversationIntelligenceCitation.create({
            data: {
              id: randomUUID(),
              tenant_id: input.tenantId,
              claim_id: claimId,
              conversation_transcript_id: cit.conversation_transcript_id,
              normalized_sha256: cit.normalized_sha256,
              utterance_id: cit.utterance_id,
              start_offset: cit.start_offset,
              end_offset: cit.end_offset,
            },
          });
        }
      }

      await tx.conversationIntelligenceDraft.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenantId,
          run_id: input.runId,
          schema_version: input.draftSchemaVersion,
          content: input.draftContent as object,
        },
      });
    });
    return (await this.findRunByIdInTenant(input.tenantId, input.runId)) as CiRunRow;
  }

  /** Tenant-scoped read of claims for a run (test/consumer read). */
  async listClaims(tenantId: string, runId: string): Promise<{ id: string; ordinal: number; status: string; claim_type: string; context_ref: string | null; statement: string }[]> {
    const rows = await this.prisma.conversationIntelligenceClaim.findMany({
      where: { tenant_id: tenantId, run_id: runId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true, status: true, claim_type: true, context_ref: true, statement: true },
    });
    return rows as { id: string; ordinal: number; status: string; claim_type: string; context_ref: string | null; statement: string }[];
  }
}
