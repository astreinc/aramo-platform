import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ActorKind } from '@aramo/auth';
import { PipelineRepository } from '@aramo/pipeline';
import type { InsertPolicyDecisionRecordInput } from '@aramo/policy-store';
import { SavedListRepository } from '@aramo/saved-list';
import { SourcedTalentRepository, type SourcedTalentRow } from '@aramo/sourced-talent';
import {
  TalentDuplicateAdvisoryRepository,
  TalentRecordRepository,
  type DuplicateAdvisoryRow,
} from '@aramo/talent-record';

import {
  PromotionService,
  type PromotionOutcome,
  type SourcedArrivalRef,
} from './promotion.service.js';
import { describeSourcedArrival } from './sourced-arrival.view.js';

// ATI-SEP-1 T10 WP2 — the sourcing surface, rebuilt on ATS data only (Addenda A2
// F-1 / A3: ATS keeps sourcing; it no longer reads a trust ledger). The pool is
// the tenant's sourced_talent arrivals not yet linked to a TalentRecord; the
// drill-in is the arrival's own parsed applicant material + the ATS duplicate
// advisories that name it. Both triggers promote-then-associate behind the
// promotion gate (PromotionService.promoteArrival). Idempotent on replay: a
// linked arrival returns already_promoted; the pipeline one-live-episode refusal
// and the bench @@unique no-op a duplicate association.
//
// Wire-shape note (documented divergence): the trust fields (trust_bands,
// open_contradiction_count, trust_statements, evidence) are gone. `subject_id`
// keeps its name and now carries the sourced_talent.SourcedTalent id (also the
// drill-in route param and the SOURCED_TALENT ref_id the promote POSTs send).

export interface SourcingResult {
  status: PromotionOutcome['status'];
  talent_record_id?: string;
  // Present on a successful Add-to-Pipeline (the created pipeline row, or null
  // when the association already existed).
  pipeline_id?: string | null;
  // Present on a successful Save-to-Bench (the tenant bench list id).
  bench_id?: string;
}

export interface PoolItem {
  // The SourcedTalent id (the drill-in key + the promote ref_id).
  subject_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  source_channel: string;
  arrived_at: string;
  // PENDING_REVIEW duplicate advisories naming this arrival (review before promote).
  open_advisory_count: number;
}

export interface PoolPage {
  items: PoolItem[];
  // Opaque keyset cursor for the next page, or null when the page is the last.
  next_cursor: string | null;
}

// The ref the promote POSTs address (kept from the prior wire shape so the FE
// reads the SOURCED_TALENT ref_id off the detail unchanged).
export interface SourcingRefRow {
  ref_type: 'SOURCED_TALENT' | 'INGESTION_PAYLOAD';
  ref_id: string;
  link_source: string;
}

// A duplicate advisory as shown on the drill-in (ids + named kinds only).
export interface ArrivalAdvisory {
  id: string;
  talent_record_id: string;
  talent_record_name: string | null;
  basis: string;
  shared_kinds: string[];
  status: string;
  created_at: string;
}

export interface SubjectDetail {
  subject_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  headline: string | null;
  profile_url: string | null;
  source_channel: string;
  arrived_at: string;
  refs: SourcingRefRow[];
  open_identity_advisories: ArrivalAdvisory[];
}

// Bounded batch scan while filling a pool page past linked arrivals.
const POOL_SCAN_ROUNDS = 10;

@Injectable()
export class SourcingService {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly promotion: PromotionService,
    private readonly pipelines: PipelineRepository,
    private readonly savedLists: SavedListRepository,
    private readonly sourced: SourcedTalentRepository,
    private readonly advisories: TalentDuplicateAdvisoryRepository,
    private readonly talentRecords: TalentRecordRepository,
  ) {}

  // The pool page: un-linked arrivals, keyset-paginated oldest-first. Arrivals
  // already linked to a record (a different schema) are filtered out batch by
  // batch until the page fills or the tenant's arrivals are exhausted.
  async getPool(
    tenant_id: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<PoolPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let cursor = decodeCursor(opts.cursor ?? null);
    const picked: SourcedTalentRow[] = [];
    let more = true;
    for (let round = 0; round < POOL_SCAN_ROUNDS && picked.length < limit; round += 1) {
      const batch = await this.sourced.listByTenantKeyset({ tenant_id, limit, cursor });
      const linked = await this.advisories.findLinkedArrivalIds(
        tenant_id,
        batch.map((r) => r.id),
      );
      let consumed = 0;
      for (const row of batch) {
        if (picked.length === limit) break;
        consumed += 1;
        cursor = { created_at: row.created_at, id: row.id };
        if (!linked.has(row.id)) picked.push(row);
      }
      // A short batch fully consumed = the tenant's arrivals are exhausted.
      if (batch.length < limit && consumed === batch.length) {
        more = false;
        break;
      }
    }

    const pending = await this.advisories.countPendingByArrivals(
      tenant_id,
      picked.map((r) => r.id),
    );
    const items: PoolItem[] = picked.map((r) => {
      const d = describeSourcedArrival(r);
      return {
        subject_id: r.id,
        display_name: d.display_name,
        email: d.email,
        phone: d.phone,
        source_channel: r.source_channel,
        arrived_at: r.arrived_at.toISOString(),
        open_advisory_count: pending.get(r.id) ?? 0,
      };
    });

    const next_cursor = more && cursor !== null ? encodeCursor(cursor.created_at, cursor.id) : null;
    return { items, next_cursor };
  }

  // The arrival drill-in — 404 when the arrival is not in the caller's tenant.
  async getSubjectDetail(tenant_id: string, sourcedTalentId: string): Promise<SubjectDetail> {
    const row = await this.sourced.findById(sourcedTalentId);
    if (row === null || row.tenant_id !== tenant_id) {
      throw new NotFoundException(`sourced arrival ${sourcedTalentId} not found in tenant`);
    }
    const d = describeSourcedArrival(row);
    const advisories = await this.advisories.listForArrival(tenant_id, row.id, 'PENDING_REVIEW');
    const names = await this.recordNames(tenant_id, advisories);
    const refs: SourcingRefRow[] = [
      { ref_type: 'SOURCED_TALENT', ref_id: row.id, link_source: row.source_channel },
      ...(d.ingestion_payload_id !== null
        ? [{ ref_type: 'INGESTION_PAYLOAD' as const, ref_id: d.ingestion_payload_id, link_source: 'ingestion' }]
        : []),
    ];
    return {
      subject_id: row.id,
      display_name: d.display_name,
      email: d.email,
      phone: d.phone,
      headline: d.headline,
      profile_url: d.profile_url,
      source_channel: row.source_channel,
      arrived_at: row.arrived_at.toISOString(),
      refs,
      open_identity_advisories: advisories.map((a) => ({
        id: a.id,
        talent_record_id: a.talent_record_a_id,
        talent_record_name: names.get(a.talent_record_a_id) ?? null,
        basis: a.basis,
        shared_kinds: a.shared_kinds,
        status: a.status,
        created_at: a.created_at.toISOString(),
      })),
    };
  }

  private async recordNames(
    tenant_id: string,
    advisories: readonly DuplicateAdvisoryRow[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(advisories.map((a) => a.talent_record_a_id))];
    if (ids.length === 0) return new Map();
    return this.talentRecords.findNamesByIds({ tenant_id, ids });
  }

  // Trigger 1 — Add to Pipeline: promote (gated) → associate the minted record
  // to the requisition. A gate deferral short-circuits (no mint, no pipeline).
  async promoteAndAddToPipeline(
    subjectRef: SourcedArrivalRef,
    requisitionId: string,
    // ADR-0024 PR-3b — `provenance` is an OPAQUE §D17a record the command
    // boundary (SourcingController) already produced from an ALLOW decision.
    // The service does not inspect it, does not know about capabilities,
    // decisions or the engine; it only threads it into the pipeline write so
    // the provenance commits INSIDE the same mutation transaction.
    opts?: {
      requestId?: string;
      provenance?: InsertPolicyDecisionRecordInput;
      created_by_id?: string;
      // Lane 2 / L2-D — the initiating actor kind (AuthContext.actor_kind), threaded
      // so the ARAMO_SOURCING entry-provenance records who birthed the episode.
      initiated_by_kind?: ActorKind;
      // Talent Lifecycle R1–R5 Impl Directive v1.2 §2.2 T-6 — the requisition status the
      // ADD policy decision was made on; the create transaction refuses if it changed.
      expected_requisition_status?: string | null;
    },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteArrival(subjectRef, {
      ...(opts?.requestId === undefined ? {} : { requestId: opts.requestId }),
      actor_id: opts?.created_by_id ?? null,
    });
    if (!isPromoted(outcome)) return { status: outcome.status };

    const talent_record_id = outcome.talent_record_id;
    let pipeline_id: string | null = null;
    try {
      const pipeline = await this.pipelines.create({
        tenant_id: subjectRef.tenant_id,
        input: { talent_record_id, requisition_id: requisitionId },
        ...(opts?.requestId === undefined ? {} : { requestId: opts.requestId }),
        ...(opts?.provenance === undefined ? {} : { provenance: opts.provenance }),
        ...(opts?.created_by_id === undefined ? {} : { created_by_id: opts.created_by_id }),
        ...(opts?.expected_requisition_status === undefined
          ? {}
          : { expected_requisition_status: opts.expected_requisition_status }),
        // Lane 2 / L2-D — the Aramo-sourcing episode birth: ARAMO_SOURCING. The
        // sourced subject's OWN upstream ingestion source is SRC-1 territory (out of
        // scope), so source_system stays null here.
        entry_provenance: {
          origin_type: 'ARAMO_SOURCING',
          initiated_by_kind: opts?.initiated_by_kind ?? 'user',
          ...(opts?.created_by_id === undefined
            ? {}
            : { initiated_by_id: opts.created_by_id }),
        },
      });
      pipeline_id = pipeline.id;
    } catch (err) {
      // E6 Q-2 — idempotent no-op ONLY on the explicit one-live-episode refusal
      // produced by the pipeline application guard (PIPELINE_EPISODE_ALREADY_LIVE).
      // This deliberately does NOT catch a generic P2002/23505: E6 replaced the
      // old bare-uniqueness reliance with a deterministic, exact refusal.
      if (!isLiveEpisodeAlready(err)) throw err;
      this.logger.log(
        `promoteAndAddToPipeline: talent ${talent_record_id} already has a live episode in requisition ${requisitionId} (idempotent no-op)`,
      );
    }
    return { status: outcome.status, talent_record_id, pipeline_id };
  }

  // Trigger 2 — Save to Pool: promote (gated) → add the minted record to the
  // tenant-shared sourcing bench. A gate deferral short-circuits.
  async promoteAndSaveToBench(
    subjectRef: SourcedArrivalRef,
    opts?: { requestId?: string; actor_id?: string | null },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteArrival(subjectRef, opts);
    if (!isPromoted(outcome)) return { status: outcome.status };

    const talent_record_id = outcome.talent_record_id;
    const bench = await this.savedLists.getOrCreateTenantBench(subjectRef.tenant_id);
    await this.savedLists.addToTenantBench({
      tenant_id: subjectRef.tenant_id,
      bench_id: bench.id,
      talent_record_id,
    });
    return { status: outcome.status, talent_record_id, bench_id: bench.id };
  }
}

function isPromoted(
  o: PromotionOutcome,
): o is Extract<PromotionOutcome, { talent_record_id: string }> {
  return o.status === 'promoted' || o.status === 'already_promoted';
}

// E6 Q-2 — the pipeline application guard's one-live-episode refusal
// (PIPELINE_EPISODE_ALREADY_LIVE). The sourcing trigger treats this as an
// idempotent no-op. Identified by the exact error code, NOT a generic P2002.
function isLiveEpisodeAlready(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'PIPELINE_EPISODE_ALREADY_LIVE'
  );
}

// ---- keyset helpers ----------------------------------------------------------

// Opaque keyset cursor = base64url("<created_at ISO>|<subject_id>").
function encodeCursor(created_at: Date, id: string): string {
  return Buffer.from(`${created_at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): { created_at: Date; id: string } | null {
  if (cursor === null || cursor.length === 0) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const ts = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    const created_at = new Date(ts);
    if (id.length === 0 || Number.isNaN(created_at.getTime())) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}
