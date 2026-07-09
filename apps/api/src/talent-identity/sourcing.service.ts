import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PipelineRepository } from '@aramo/pipeline';
import { SavedListRepository } from '@aramo/saved-list';
import {
  deriveTrustStatements,
  TalentTrustRepository,
  type SubjectRef,
  type EvidenceRecordRow,
  type ResolutionSubjectRefRow,
  type SubjectMatchAdvisoryRow,
  type TrustStateRow,
} from '@aramo/talent-trust';

import { PromotionService, type PromotionOutcome } from './promotion.service.js';

// Promotion-Trigger slice-A — the two sourcer triggers, both promote-then-
// associate behind the identity gate (which lives in promoteSubject). apps/api
// orchestration above the I15 wall: reads cip talent-trust (via promoteSubject),
// writes ats talent-record / pipeline / saved-list. Idempotent on replay:
// promoteSubject no-ops an already-promoted subject; the pipeline
// @@unique([talent_record_id, requisition_id]) and the bench
// @@unique([saved_list_id, item_id]) no-op a duplicate association.
//
// A gate deferral (deferred_unresolved_identity / deferred_no_name / …) short-
// circuits: NO record is minted and NO association happens — the outcome carries
// the deferral status straight through.

export interface SourcingResult {
  status: PromotionOutcome['status'];
  talent_record_id?: string;
  // Present on a successful Add-to-Pipeline (the created pipeline row, or null
  // when the association already existed).
  pipeline_id?: string | null;
  // Present on a successful Save-to-Bench (the tenant bench list id).
  bench_id?: string;
}

// Promotion-Trigger slice B-api — the sourcing-pool read shapes.
export interface TrustBands {
  identity: string | null;
  claims: string | null;
  continuity: string | null;
  eligibility: string | null;
}

export interface PoolItem {
  subject_id: string;
  display_name: string | null;
  email: string | null;
  trust_bands: TrustBands;
  open_contradiction_count: number;
}

export interface PoolPage {
  items: PoolItem[];
  // Opaque keyset cursor for the next page, or null when the page is the last.
  next_cursor: string | null;
}

// TR-14 B1 (DDR §2.4) — the sourcing evidence row WITHOUT `strength`. The ordinal
// is stripped server-side (a trust product does not ship an ungated number); the
// FE already omitted it by type, pact never pinned it.
export type SourcingEvidenceRow = Omit<EvidenceRecordRow, 'strength'>;

export interface SubjectDetail {
  subject_id: string;
  display_name: string | null;
  email: string | null;
  trust_bands: TrustBands | null;
  open_contradiction_count: number;
  // TR-5 B2 (DDR §4, β1) — the named-thinness assessment statements, rendered
  // from the TrustState flags by deriveTrustStatements. STRINGS ONLY (a fixed,
  // locked sentence set) — no count, span, or ordinal ever crosses this wire; the
  // numeric payloads stay in the ledger, visible only via `evidence[]`.
  trust_statements: string[];
  evidence: SourcingEvidenceRow[];
  refs: ResolutionSubjectRefRow[];
  // The PRE-promotion needs-review: pending same-human MERGE advisories (subject-
  // keyed). Attribute contradictions are post-promotion (record-keyed) — NOT here.
  open_identity_advisories: SubjectMatchAdvisoryRow[];
}

@Injectable()
export class SourcingService {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly promotion: PromotionService,
    private readonly pipelines: PipelineRepository,
    private readonly savedLists: SavedListRepository,
    private readonly trustRepo: TalentTrustRepository,
  ) {}

  // ---- Promotion-Trigger slice B-api — the sourcing-surface readers ----------

  // The pre-promotion pool page: the anti-join list (bands + contradiction count)
  // + ONE batched display-name/email read for the page's subjects (no N+1).
  // Keyset-paginated oldest-first; next_cursor is opaque (created_at|id).
  async getPool(
    tenant_id: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<PoolPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const cursor = decodeCursor(opts.cursor ?? null);
    const rows = await this.trustRepo.listSourcedPool({ tenant_id, limit, cursor });

    const subjectIds = rows.map((r) => r.subject_id);
    const evidence = await this.trustRepo.listDisplayIdentityEvidence(tenant_id, subjectIds);
    const display = groupDisplay(evidence);

    const items: PoolItem[] = rows.map((r) => ({
      subject_id: r.subject_id,
      display_name: display.get(r.subject_id)?.name ?? null,
      email: display.get(r.subject_id)?.email ?? null,
      trust_bands: {
        identity: r.identity_band,
        claims: r.claims_band,
        continuity: r.continuity_band,
        eligibility: r.eligibility_band,
      },
      open_contradiction_count: r.open_contradiction_count,
    }));

    const last = rows[rows.length - 1];
    const next_cursor =
      rows.length === limit && last !== undefined
        ? encodeCursor(last.created_at, last.subject_id)
        : null;
    return { items, next_cursor };
  }

  // The subject drill-in: trust bands + evidence ledger + refs + PENDING identity
  // advisories — composed from the subject_id-keyed talent_trust readers, all
  // tenant-scoped. 404 if the subject is not in the caller's tenant.
  async getSubjectDetail(tenant_id: string, subjectId: string): Promise<SubjectDetail> {
    const subject = await this.trustRepo.findSubjectById(subjectId);
    if (subject === null || subject.tenant_id !== tenant_id) {
      throw new NotFoundException(`subject ${subjectId} not found in tenant`);
    }
    // TR-14 B1 (DDR §2.3) — ONE STORY: the evidence goes CLUSTER-UNION, the same
    // set the bands derive from at recompute. Previously single-subject
    // (listEvidenceBySubject) → a merged cluster's bands and evidence diverged.
    // A pool subject is ACTIVE (its own fixpoint), so clusterMembers(subjectId) IS
    // the recompute's union set.
    const members = await this.trustRepo.clusterMembers(subjectId);
    const [trustState, evidenceRows, refs, advisories]: [
      TrustStateRow | null,
      EvidenceRecordRow[],
      ResolutionSubjectRefRow[],
      SubjectMatchAdvisoryRow[],
    ] = await Promise.all([
      this.trustRepo.findTrustStateBySubject(subjectId),
      this.trustRepo.listEvidenceBySubjects(members),
      this.trustRepo.listRefsBySubject(subjectId),
      this.trustRepo.listMatchAdvisories(tenant_id, { subjectId, status: 'PENDING_REVIEW' }),
    ]);
    // TR-14 B1 (DDR §2.4) — STRIP the ungated `strength` ordinal off the wire
    // (blast radius ~zero: FE omits it, pact does not pin it). The dossier (B2)
    // never carries it either.
    const evidence: SourcingEvidenceRow[] = evidenceRows.map(
      ({ strength: _strength, ...rest }) => rest,
    );
    const display = groupDisplay(
      evidence
        .filter((e) => e.current_status === 'VALID' && (e.assertion_type === 'FULL_NAME' || e.assertion_type === 'EMAIL'))
        .map((e) => ({ subject_id: subjectId, assertion_type: e.assertion_type, assertion_payload: e.assertion_payload })),
    );
    return {
      subject_id: subjectId,
      display_name: display.get(subjectId)?.name ?? null,
      email: display.get(subjectId)?.email ?? null,
      trust_bands:
        trustState === null
          ? null
          : {
              identity: trustState.identity_band,
              claims: trustState.claims_band,
              continuity: trustState.continuity_band,
              eligibility: trustState.eligibility_band,
            },
      open_contradiction_count: trustState?.open_contradiction_count ?? 0,
      trust_statements:
        trustState === null
          ? []
          : deriveTrustStatements({
              single_source_only: trustState.single_source_only,
              longitudinal_observed: trustState.longitudinal_observed,
              verified_control_stale: trustState.verified_control_stale,
            }),
      evidence,
      refs,
      open_identity_advisories: advisories,
    };
  }

  // Trigger 1 — Add to Pipeline: promote (gated) → associate the minted record
  // to the requisition. A gate deferral short-circuits (no mint, no pipeline).
  async promoteAndAddToPipeline(
    subjectRef: SubjectRef,
    requisitionId: string,
    opts?: { requestId?: string },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteSubject(subjectRef, opts);
    if (!isPromoted(outcome)) return { status: outcome.status };

    const talent_record_id = outcome.talent_record_id;
    let pipeline_id: string | null = null;
    try {
      const pipeline = await this.pipelines.create({
        tenant_id: subjectRef.tenant_id,
        input: { talent_record_id, requisition_id: requisitionId },
      });
      pipeline_id = pipeline.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Already in this pipeline — idempotent no-op (the @@unique held; the
      // requisition-openings decrement rolled back with the failed insert).
      this.logger.log(
        `promoteAndAddToPipeline: talent ${talent_record_id} already in requisition ${requisitionId} pipeline (no-op)`,
      );
    }
    return { status: outcome.status, talent_record_id, pipeline_id };
  }

  // Trigger 2 — Save to Pool: promote (gated) → add the minted record to the
  // tenant-shared sourcing bench. A gate deferral short-circuits.
  async promoteAndSaveToBench(
    subjectRef: SubjectRef,
    opts?: { requestId?: string },
  ): Promise<SourcingResult> {
    const outcome = await this.promotion.promoteSubject(subjectRef, opts);
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

// Prisma unique-constraint violation (P2002) — the association already exists.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

// ---- Promotion-Trigger slice B-api — display + keyset helpers -----------------

interface DisplayEntry {
  name?: string;
  email?: string;
}

// Group the batched FULL_NAME/EMAIL evidence per subject. The reader returns
// newest-first, so the FIRST FULL_NAME / EMAIL seen for a subject is the newest.
function groupDisplay(
  rows: Array<{ subject_id: string; assertion_type: string; assertion_payload: unknown }>,
): Map<string, DisplayEntry> {
  const out = new Map<string, DisplayEntry>();
  for (const r of rows) {
    const entry = out.get(r.subject_id) ?? {};
    const p = payloadObj(r.assertion_payload);
    if (r.assertion_type === 'FULL_NAME' && entry.name === undefined) {
      const parts = [str(p['first_name']), str(p['last_name'])].filter(
        (x): x is string => x !== undefined,
      );
      if (parts.length > 0) entry.name = parts.join(' ');
    } else if (r.assertion_type === 'EMAIL' && entry.email === undefined) {
      // TR-4 B1 (DDR §2.3) — contact writers CONVERGED on `value` as of 2026-07-08;
      // this dual-read stays for pre-convergence rows keyed `normalized_value`
      // (append-only history — no rewrite).
      const email = str(p['normalized_value']) ?? str(p['value']);
      if (email !== undefined) entry.email = email;
    }
    out.set(r.subject_id, entry);
  }
  return out;
}

function payloadObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

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
