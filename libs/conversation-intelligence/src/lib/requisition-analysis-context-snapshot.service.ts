import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';

import {
  buildRequisitionAnalysisContext,
  REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
} from './dto/requisition-analysis-context.js';
import type { RequisitionAnalysisContextSnapshotView } from './dto/requisition-analysis-context-snapshot.view.js';
import { RequisitionAnalysisContextSnapshotRepository } from './requisition-analysis-context-snapshot.repository.js';
import {
  REQUISITION_ANALYSIS_CONTEXT_READER,
  type RequisitionAnalysisContextReader,
} from './reader/requisition-analysis-context-reader.js';

// CI-B2 — the immutable Requisition analysis-context snapshot creation
// service. Per Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md
// §10 creation semantics.
//
// captureSnapshot is the single creation path. The caller supplies only
// (tenant_id, requisition_id) + an actor context — NEVER snapshot
// content. The server:
//   1. resolves the authorized, allowlisted recruiting context via the
//      reader port (which enforces tenant concealment + field allowlist);
//   2. concealing NOT_FOUND when the requisition is absent in tenant;
//   3. constructs the schema-versioned immutable payload from that source
//      (the builder is the allowlist authority — no client-chosen field
//      can enter the snapshot);
//   4. persists exactly once and returns the snapshot reference.
//
// captureSnapshot performs NO lifecycle mutation: it reads the
// Requisition (and GoldenProfile) and writes only its own snapshot row.
// It never changes Requisition status, Pipeline, Talent, Consent, or any
// other domain (directive §15 no-authority-expansion, §21 said-vs-done).

export interface CaptureRequisitionAnalysisContextInput {
  tenant_id: string;
  requisition_id: string;
  // Actor / request context for provenance + logging. CI-B2 does not
  // itself gate the actor (that is a CI-B6 orchestration concern); the
  // security boundary here is tenant scoping + the field allowlist.
  actor?: { user_id?: string; request_id?: string };
}

@Injectable()
export class RequisitionAnalysisContextSnapshotService {
  constructor(
    @Inject(REQUISITION_ANALYSIS_CONTEXT_READER)
    private readonly reader: RequisitionAnalysisContextReader,
    private readonly repository: RequisitionAnalysisContextSnapshotRepository,
    @Inject('RequisitionAnalysisContextSnapshotServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async captureSnapshot(
    input: CaptureRequisitionAnalysisContextInput,
  ): Promise<RequisitionAnalysisContextSnapshotView> {
    const requestId = input.actor?.request_id ?? 'conversation-intelligence';

    const source = await this.reader.load({
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
    });

    if (source === null) {
      // Conceal: report a cross-tenant / absent requisition as NOT_FOUND,
      // never revealing existence (requisition repository convention).
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant',
        404,
        {
          requestId,
          details: {
            tenant_id: input.tenant_id,
            requisition_id: input.requisition_id,
          },
        },
      );
    }

    const context = buildRequisitionAnalysisContext(source);

    const view = await this.repository.createSnapshot({
      id: randomUUID(),
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      source_requisition_version: source.source_requisition_version,
      golden_profile_id: source.golden_profile_id,
      snapshot_schema_version: REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
      context,
      captured_at: new Date(),
    });

    this.logger.log({
      event: 'requisition_analysis_context_snapshot.captured',
      tenant_id: view.tenant_id,
      requisition_id: view.requisition_id,
      snapshot_id: view.id,
      snapshot_schema_version: view.snapshot_schema_version,
      source_requisition_version: view.source_requisition_version,
    });

    return view;
  }

  // Read-only accessors — a future CI run binds to a snapshot by stable
  // id (tenant-scoped). No mutation surface is exposed.
  async getSnapshot(
    tenant_id: string,
    id: string,
  ): Promise<RequisitionAnalysisContextSnapshotView | null> {
    return this.repository.findById(tenant_id, id);
  }

  async listSnapshotsForRequisition(
    tenant_id: string,
    requisition_id: string,
  ): Promise<RequisitionAnalysisContextSnapshotView[]> {
    return this.repository.findByRequisitionId(tenant_id, requisition_id);
  }
}
