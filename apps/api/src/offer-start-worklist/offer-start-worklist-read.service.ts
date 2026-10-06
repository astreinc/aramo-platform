import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';
import {
  OfferRepository,
  PlacementRepository,
  OFFER_STATE_POSITION,
  deriveOfferStartExceptions,
  type OfferView,
  type PlacementProcessView,
} from '@aramo/placement';
import { PipelineRepository, PIPELINE_STATUS_VALUES } from '@aramo/pipeline';
import { TalentRecordRepository } from '@aramo/talent-record';
import { RequisitionRepository } from '@aramo/requisition';
import { CompanyRepository } from '@aramo/company';

import type {
  OfferStartWorklistResponse,
  OfferStartWorklistRow,
  WorklistPhase,
} from './dto/offer-start-worklist.view.js';

// Offer & Start §9 — the cross-requisition Offer & Start WORKLIST composer. apps/api is the only
// layer allowed to compose across owners (the talent-journey precedent). READ-ONLY; issues zero
// writes; persists NO status and is NOT a Placement authority (PO ruling: a row may have an Offer
// but no PlacementProcess yet). Composition is BATCH set-reads — NEVER per-row/per-requisition
// fan-out (§9.5):
//   { offers, placements } cross-req (visibility-scoped) → union by (requisition, talent),
//   deepest owner wins (Placement > Offer) → ONE pipeline read resolves episode ids → ONE talent
//   names read + ONE requisition summaries read + ONE company names read.
// Visibility (AUTHZ-D4b) is the pre-resolved visible_requisition_ids set threaded into every
// owner read (null = see-all); there is no fetch-all-then-filter.

// Episode resolution spans every NON-VOIDED pipeline status (a started person's episode may sit
// at qualified/completed); a voided episode is administratively removed and never deep-linked.
const NON_VOIDED_STATUSES = PIPELINE_STATUS_VALUES.filter((s) => s !== 'voided');

const LIST_LIMIT = 200;

const key = (requisitionId: string, talentId: string): string => `${requisitionId}|${talentId}`;

@Injectable()
export class OfferStartWorklistReadService {
  constructor(
    private readonly offer: OfferRepository,
    private readonly placement: PlacementRepository,
    private readonly pipeline: PipelineRepository,
    private readonly talent: TalentRecordRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly company: CompanyRepository,
    @Inject('OfferStartWorklistLogger') private readonly logger: AramoLogger,
  ) {}

  async getWorklist(args: {
    tenant_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requestId: string;
  }): Promise<OfferStartWorklistResponse> {
    const vis = args.visible_requisition_ids;
    // See-all with no visible set would be unbounded; the owner reads are each limit-capped, and a
    // scoped actor always carries a set. An EMPTY visible set (actor sees nothing) short-circuits.
    if (vis !== null && vis.size === 0) {
      return { items: [], total: 0 };
    }

    // ---- owner set-reads (cross-requisition, visibility-scoped) ----
    const [offers, placements] = await Promise.all([
      this.offer.list({ tenant_id: args.tenant_id, visible_requisition_ids: vis, limit: LIST_LIMIT }),
      this.placement.listForActor({ tenant_id: args.tenant_id, visible_requisition_ids: vis, limit: LIST_LIMIT }),
    ]);

    // ---- union by (requisition, talent); the DEEPEST owner (Placement > Offer) defines the row ----
    const placementByKey = new Map<string, PlacementProcessView>();
    for (const p of placements) {
      if (!isActivePlacementPhase(p.state)) continue; // terminal NO_SHOW/FELL_THROUGH are not active worklist
      placementByKey.set(key(p.requisition_id, p.talent_record_id), p);
    }
    const offerByKey = new Map<string, OfferView>();
    for (const o of offers) {
      const k = key(o.requisition_id, o.talent_record_id);
      if (placementByKey.has(k)) continue; // a placement supersedes the offer phase
      const existing = offerByKey.get(k);
      // offers are created_at desc; prefer the live one, else keep the most recent (first seen).
      if (existing === undefined) offerByKey.set(k, o);
      else if (OFFER_STATE_POSITION[existing.state] === 'CLOSED' && OFFER_STATE_POSITION[o.state] !== 'CLOSED') {
        offerByKey.set(k, o);
      }
    }

    // Drop offer-only rows whose single offer is terminal-and-non-exception (RESCINDED): a
    // withdrawn offer with no placement is not an active worklist item.
    for (const [k, o] of offerByKey) {
      if (o.state === 'RESCINDED') offerByKey.delete(k);
    }

    const placementRows = [...placementByKey.values()];
    const offerRows = [...offerByKey.values()];
    if (placementRows.length === 0 && offerRows.length === 0) {
      return { items: [], total: 0 };
    }

    // ---- batch resolve: episode ids, talent names, requisition summaries, company names ----
    const reqIds = new Set<string>();
    const talentIds = new Set<string>();
    for (const p of placementRows) { reqIds.add(p.requisition_id); talentIds.add(p.talent_record_id); }
    for (const o of offerRows) { reqIds.add(o.requisition_id); talentIds.add(o.talent_record_id); }

    const [episodes, talentNames, reqSummaries] = await Promise.all([
      this.pipeline.listByRequisitionsAndStatus({ tenant_id: args.tenant_id, requisition_ids: [...reqIds], statuses: NON_VOIDED_STATUSES, limit: 5000 }),
      this.talent.findNamesByIds({ tenant_id: args.tenant_id, ids: [...talentIds] }),
      this.requisitions.findSummariesByIds({ tenant_id: args.tenant_id, ids: [...reqIds] }),
    ]);
    const episodeByKey = new Map<string, string>();
    for (const e of episodes) {
      const k = key(e.requisition_id, e.talent_record_id);
      if (!episodeByKey.has(k)) episodeByKey.set(k, e.id); // first (updated_at desc) is the live-most episode
    }
    const reqByIdSummary = new Map(reqSummaries.map((r) => [r.id, r]));
    const companyIds = new Set<string>();
    for (const r of reqSummaries) companyIds.add(r.company_id);
    const companyNames = await this.company.findNamesByIds({ tenant_id: args.tenant_id, ids: [...companyIds] });

    // ---- compose rows ----
    const rows: OfferStartWorklistRow[] = [];
    for (const p of placementRows) {
      const k = key(p.requisition_id, p.talent_record_id);
      rows.push(composePlacementRow(p, k, episodeByKey, talentNames, reqByIdSummary, companyNames));
    }
    for (const o of offerRows) {
      const k = key(o.requisition_id, o.talent_record_id);
      rows.push(composeOfferRow(o, k, episodeByKey, talentNames, reqByIdSummary, companyNames));
    }

    // Exception-first (§9.3), then most-advanced phase, then most-recent.
    rows.sort((a, b) => {
      if (a.has_exception !== b.has_exception) return a.has_exception ? -1 : 1;
      const po = PHASE_ORDINAL[b.phase] - PHASE_ORDINAL[a.phase];
      if (po !== 0) return po;
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
    });

    const items = rows.slice(0, LIST_LIMIT);
    this.logger.log({ event: 'offer_start_worklist_composed', count: items.length, offers: offerRows.length, placements: placementRows.length });
    return { items, total: items.length };
  }
}

type ReqSummary = { readonly id: string; readonly requisition_number: number; readonly title: string; readonly company_id: string };

function resolveShared(
  k: string,
  requisitionId: string,
  talentId: string,
  episodeByKey: ReadonlyMap<string, string>,
  talentNames: ReadonlyMap<string, string>,
  reqByIdSummary: ReadonlyMap<string, ReqSummary>,
  companyNames: ReadonlyMap<string, string>,
): Pick<OfferStartWorklistRow, 'pipeline_id' | 'requisition_id' | 'requisition_number' | 'requisition_title' | 'client_name' | 'talent_record_id' | 'talent_name'> {
  const summary = reqByIdSummary.get(requisitionId);
  return {
    pipeline_id: episodeByKey.get(k) ?? null,
    requisition_id: requisitionId,
    requisition_number: summary?.requisition_number ?? null,
    requisition_title: summary?.title ?? null,
    client_name: summary === undefined ? null : companyNames.get(summary.company_id) ?? null,
    talent_record_id: talentId,
    talent_name: talentNames.get(talentId) ?? null,
  };
}

function composePlacementRow(
  p: PlacementProcessView,
  k: string,
  episodeByKey: ReadonlyMap<string, string>,
  talentNames: ReadonlyMap<string, string>,
  reqByIdSummary: ReadonlyMap<string, ReqSummary>,
  companyNames: ReadonlyMap<string, string>,
): OfferStartWorklistRow {
  const engagement = p.placement_kind === 'PERMANENT' ? 'PERMANENT' : 'CONTRACT';
  const { phase, label } = placementPhase(p.state, engagement);
  // Exception = the canonical offer-start exception semantic (not re-decided here).
  const exception = deriveOfferStartExceptions({ offer_state: null, placement_state: p.state })[0] ?? null;
  return {
    ...resolveShared(k, p.requisition_id, p.talent_record_id, episodeByKey, talentNames, reqByIdSummary, companyNames),
    phase,
    phase_label: label,
    engagement,
    has_exception: exception !== null,
    exception_summary: exception?.detail ?? null,
    updated_at: p.offered_at === undefined ? null : p.offered_at.toISOString(),
  };
}

function composeOfferRow(
  o: OfferView,
  k: string,
  episodeByKey: ReadonlyMap<string, string>,
  talentNames: ReadonlyMap<string, string>,
  reqByIdSummary: ReadonlyMap<string, ReqSummary>,
  companyNames: ReadonlyMap<string, string>,
): OfferStartWorklistRow {
  const engagement = o.compensation_type === 'PERMANENT' ? 'PERMANENT' : o.compensation_type === 'CONTRACT' ? 'CONTRACT' : null;
  const { phase, label } = offerPhase(o.state);
  const exception = deriveOfferStartExceptions({ offer_state: o.state, placement_state: null })[0] ?? null;
  return {
    ...resolveShared(k, o.requisition_id, o.talent_record_id, episodeByKey, talentNames, reqByIdSummary, companyNames),
    phase,
    phase_label: label,
    engagement,
    has_exception: exception !== null,
    exception_summary: exception?.detail ?? null,
    updated_at: o.created_at,
  };
}

// Only ACTIVE placement phases belong to the worklist; terminal NO_SHOW / FELL_THROUGH placements
// have left the offer→start flow.
function isActivePlacementPhase(state: PlacementProcessView['state']): boolean {
  return state === 'PRE_START' || state === 'READY_TO_START' || state === 'STARTED' || state === 'BLOCKED';
}

// The worklist PHASE is this list's own position/grouping vocabulary (used for the
// exception-first + most-advanced sort). The live "needs attention" exception is a
// SEPARATE concern sourced from the canonical deriveOfferStartExceptions — never
// restated here.
function placementPhase(
  state: PlacementProcessView['state'],
  engagement: 'CONTRACT' | 'PERMANENT',
): { phase: WorklistPhase; label: string } {
  switch (state) {
    case 'STARTED':
      return { phase: 'STARTED', label: engagement === 'PERMANENT' ? 'Placement recorded' : 'Started · active assignment' };
    case 'READY_TO_START':
      return { phase: 'READY', label: 'Ready to start' };
    case 'BLOCKED':
      return { phase: 'BLOCKED', label: 'Pre-start blocked' };
    default: // PRE_START
      return { phase: 'PRE_START', label: 'Pre-start' };
  }
}

function offerPhase(state: OfferView['state']): { phase: WorklistPhase; label: string } {
  switch (state) {
    case 'ACCEPTED':
      return { phase: 'ACCEPTED', label: 'Offer accepted' };
    case 'DECLINED':
      return { phase: 'OFFER_DECLINED', label: 'Offer declined' };
    case 'EXPIRED':
      return { phase: 'OFFER_EXPIRED', label: 'Offer expired' };
    case 'DRAFT':
      return { phase: 'OFFER', label: 'Offer prepared' };
    default: // SENT / NEGOTIATION
      return { phase: 'OFFER', label: 'Offer sent' };
  }
}

// Phase advancement for the secondary sort — later phases sort first within the non-exception group.
const PHASE_ORDINAL: Record<WorklistPhase, number> = {
  OFFER_DECLINED: 7,
  OFFER_EXPIRED: 7,
  BLOCKED: 7,
  STARTED: 6,
  READY: 5,
  PRE_START: 4,
  ACCEPTED: 3,
  OFFER: 2,
};
