import { Injectable } from '@nestjs/common';
import { ClientTalentRestrictionRepository } from '@aramo/client-talent-restriction';
import { ConsentRepository } from '@aramo/consent';
import {
  ClientSelectionProcessRepository,
  InterviewSessionRepository,
} from '@aramo/client-selection';
import { CompanyRepository } from '@aramo/company';
import { OfferRepository, PlacementRepository } from '@aramo/placement';
import { ACTIVE_FLOW_STAGES, PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { SubmittalRepository } from '@aramo/submittal';
import {
  RequisitionSubmittalEligibilityReader,
  deriveSubmittalReadiness,
  type SubmittalPolicyInputs,
} from '@aramo/submittal-eligibility';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TalentExtractionService } from '@aramo/talent-extraction';
import { TaskRepository } from '@aramo/task';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';
import { EngagementGateService } from '../engagement/engagement-gate.service.js';

import type {
  DeskActorContext,
  DeskAwaitingRow,
  DeskBlockedPlacementRow,
  DeskDayWindow,
  DeskInterviewRow,
  DeskOfferRow,
  DeskReadinessRow,
  DeskRequisitionCounts,
  DeskRequisitionRow,
  DeskTaskOwnerType,
  DeskTaskRow,
  DeskTaskType,
  DeskUnfinishedTalentRow,
  MyDeskReadPort,
} from './my-desk.ports.js';

// The concrete MyDeskReadPort — the ONLY layer that touches the real domain
// repositories. It maps each aggregate's view down to the narrow desk row shape
// and does no derivation (that lives in MyDeskService/my-desk.derivation.ts).
// Every list is bounded; the visibility set is passed through untouched
// (server-resolved, never client-supplied — directive §24).
const LIST_LIMIT = 200;

@Injectable()
export class MyDeskReadAdapter implements MyDeskReadPort {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly pipelines: PipelineRepository,
    private readonly interviews: InterviewSessionRepository,
    private readonly clientSelection: ClientSelectionProcessRepository,
    private readonly placements: PlacementRepository,
    private readonly offers: OfferRepository,
    private readonly talent: TalentRecordRepository,
    private readonly companies: CompanyRepository,
    // Submittal-readiness authorities (reused, never re-implemented).
    private readonly eligibilityReader: RequisitionSubmittalEligibilityReader,
    private readonly documentReadiness: DocumentReadinessGate,
    private readonly restriction: ClientTalentRestrictionRepository,
    private readonly engagement: EngagementGateService,
    private readonly submittals: SubmittalRepository,
    private readonly consent: ConsentRepository,
    // Talent Draft Recovery §19 — the actor's own unfinished intake drafts. Read
    // only (no derivation here); the service applies the eligibility rule.
    private readonly talentIntake: TalentExtractionService,
  ) {}

  async listMyTasks(ctx: DeskActorContext): Promise<readonly DeskTaskRow[]> {
    const rows = await this.tasks.listForAssignee({
      tenant_id: ctx.tenant_id,
      assignee_id: ctx.user_id,
      vis: {
        visibility: ctx.visibility,
        visible_requisition_ids: ctx.visible_requisition_ids,
        visible_contact_ids: ctx.visible_contact_ids,
      },
      limit: LIST_LIMIT,
    });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      due_date: t.due_date,
      type: t.type as DeskTaskType | null,
      owner_type: t.owner_type as DeskTaskOwnerType,
      owner_id: t.owner_id,
      requisition_id: t.requisition_id,
    }));
  }

  async listMyRequisitions(
    ctx: DeskActorContext,
  ): Promise<readonly DeskRequisitionRow[]> {
    const rows = await this.requisitions.listForActor({
      tenant_id: ctx.tenant_id,
      visibility: ctx.visibility,
    });
    return rows.map((r) => ({
      id: r.id,
      requisition_number: r.requisition_number,
      title: r.title,
      company_id: r.company_id,
      status: r.status,
      created_at: r.created_at,
      is_hot: r.is_hot,
    }));
  }

  async countsForRequisitions(
    ctx: DeskActorContext,
    requisition_ids: readonly string[],
  ): Promise<ReadonlyMap<string, DeskRequisitionCounts>> {
    if (requisition_ids.length === 0) return new Map();
    const ids = [...requisition_ids];
    // Five indexed groupBy reads across the owning domains — NO row loading,
    // NO LIST_LIMIT. Each returns [{requisition_id, count}] for the SAME id set.
    const [pipeline, qualified, withClient, offer, started] = await Promise.all([
      this.pipelines.countByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
        statuses: ACTIVE_FLOW_STAGES,
      }),
      this.pipelines.countByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
        statuses: ['qualified'],
      }),
      this.clientSelection.countWithClientByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
      this.offers.countLiveByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
      this.placements.countStartedByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
    ]);
    type MutableCounts = {
      pipeline: number;
      qualified: number;
      with_client: number;
      offer: number;
      started: number;
    };
    const acc = new Map<string, MutableCounts>();
    const ensure = (reqId: string): MutableCounts => {
      let m = acc.get(reqId);
      if (m === undefined) {
        m = { pipeline: 0, qualified: 0, with_client: 0, offer: 0, started: 0 };
        acc.set(reqId, m);
      }
      return m;
    };
    for (const r of pipeline) ensure(r.requisition_id).pipeline = r.count;
    for (const r of qualified) ensure(r.requisition_id).qualified = r.count;
    for (const r of withClient) ensure(r.requisition_id).with_client = r.count;
    for (const r of offer) ensure(r.requisition_id).offer = r.count;
    for (const r of started) ensure(r.requisition_id).started = r.count;
    return acc;
  }

  async activeRequisitionsByTalent(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    if (talent_ids.length === 0) return new Map();
    const rows = await this.pipelines.listActiveRequisitionsByTalent({
      tenant_id: ctx.tenant_id,
      talent_record_ids: [...talent_ids],
      visible_requisition_ids: ctx.visible_requisition_ids,
    });
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.talent_record_id) ?? [];
      list.push(r.requisition_id);
      out.set(r.talent_record_id, list);
    }
    return out;
  }

  async listQualifiedReadiness(
    ctx: DeskActorContext,
    requisitions: readonly { id: string; company_id: string }[],
  ): Promise<readonly DeskReadinessRow[]> {
    if (requisitions.length === 0) return [];
    const reqIds = requisitions.map((r) => r.id);
    const companyByReq = new Map(requisitions.map((r) => [r.id, r.company_id]));

    // Enumerate the QUALIFIED (talent, requisition) pairs across the visible
    // reqs. NOTE: bounded by a 500-row ceiling — a very wide desk truncates
    // here (accepted; the submit transaction remains authoritative regardless).
    const qualified = await this.pipelines.listByRequisitionsAndStatus({
      tenant_id: ctx.tenant_id,
      requisition_ids: reqIds,
      statuses: ['qualified'],
      limit: 500,
    });
    const talentsByReq = new Map<string, string[]>();
    for (const q of qualified) {
      const list = talentsByReq.get(q.requisition_id) ?? [];
      list.push(q.talent_record_id);
      talentsByReq.set(q.requisition_id, list);
    }
    if (talentsByReq.size === 0) return [];

    // Policy inputs are a single set-read across all requisitions.
    const policyByReq =
      await this.eligibilityReader.loadPolicyInputsByRequisitionIds(
        ctx.tenant_id,
        reqIds,
      );

    // Fan out the per-requisition readiness composition (each requisition's
    // reads are batched over its qualified talents; readReadiness is issued only
    // for policy_present talents).
    const now = new Date();
    const perReq = await Promise.all(
      [...talentsByReq.entries()].map(([reqId, talentIds]) => {
        const policy = policyByReq.get(reqId);
        if (policy === undefined) {
          return Promise.resolve([] as DeskReadinessRow[]);
        }
        return this.readinessForRequisition(
          ctx,
          reqId,
          talentIds,
          companyByReq.get(reqId) ?? null,
          policy,
          now,
        );
      }),
    );
    return perReq.flat();
  }

  private async readinessForRequisition(
    ctx: DeskActorContext,
    requisition_id: string,
    talent_ids: readonly string[],
    company_id: string | null,
    policy: { inputs: SubmittalPolicyInputs; consumed_count: number },
    now: Date,
  ): Promise<DeskReadinessRow[]> {
    const [rtrByTalent, restrictedSet, engagement, resumeRows, submittalRows] =
      await Promise.all([
        this.documentReadiness.assessMany({
          tenant_id: ctx.tenant_id,
          requisition_id,
          talent_ids: [...talent_ids],
        }),
        company_id === null
          ? Promise.resolve(new Set<string>())
          : this.restriction.findActiveRestrictedTalentIds({
              tenant_id: ctx.tenant_id,
              client_company_id: company_id,
              talent_record_ids: [...talent_ids],
              now,
            }),
        this.engagement.resolveApplicability({
          tenant_id: ctx.tenant_id,
          company_id,
          requisition_id,
        }),
        this.pipelines.listCurrentRequisitionResumes({
          tenant_id: ctx.tenant_id,
          requisition_id,
          talent_record_ids: [...talent_ids],
        }),
        this.submittals.listByRequisitionForBoard({
          tenant_id: ctx.tenant_id,
          requisition_id,
          visible_requisition_ids: ctx.visible_requisition_ids,
        }),
      ]);
    const submittalByTalent = new Map(submittalRows.map((s) => [s.talent_id, s]));

    // Per-grain engagement truth — issued ONLY for policy_present (the batch
    // applicability cannot evaluate per-talent evidence), batched together.
    const readinessByTalent = new Map<
      string,
      Awaited<ReturnType<EngagementGateService['readReadiness']>>
    >();
    if (engagement === 'policy_present') {
      const results = await Promise.all(
        talent_ids.map((talent_id) =>
          this.engagement.readReadiness({
            tenant_id: ctx.tenant_id,
            talent_id,
            requisition_id,
            company_id,
          }),
        ),
      );
      talent_ids.forEach((talent_id, i) => {
        const r = results[i];
        if (r !== undefined) readinessByTalent.set(talent_id, r);
      });
    }

    const rows: DeskReadinessRow[] = [];
    for (const talent_id of talent_ids) {
      const rtr_verdict = rtrByTalent.get(talent_id) ?? null;
      const restriction_active = restrictedSet.has(talent_id);
      const submittalRow = submittalByTalent.get(talent_id) ?? null;
      const resume_selected =
        (submittalRow?.resume_edition_id ?? null) !== null ||
        resumeRows.get(talent_id) !== undefined;
      const readiness = deriveSubmittalReadiness({
        policy,
        rtr_verdict,
        restriction_active,
        engagement,
        resume_selected,
        now,
      });
      // RTR is unmet for this pair (independent of which gate the port reports
      // first) — read the document verdict directly.
      const rtr_required = rtr_verdict !== null && !rtr_verdict.satisfied;
      let submittal_ready: boolean;
      let voice_required = false;
      if (engagement === 'policy_present') {
        // The batch band is conservatively UNAVAILABLE; the per-grain verdict is
        // the truth for both submittal-ready and the voice predicate.
        const rr = readinessByTalent.get(talent_id);
        const voice = rr?.results.find((x) => x.channel === 'voice');
        const email = rr?.results.find((x) => x.channel === 'email');
        voice_required =
          voice !== undefined &&
          voice.required &&
          (voice.status === 'missing' ||
            voice.status === 'insufficient_strength') &&
          email !== undefined &&
          email.status === 'satisfied';
        submittal_ready =
          rr !== undefined &&
          rr.satisfied &&
          readiness.deny === null &&
          !readiness.resume_missing;
      } else {
        submittal_ready = readiness.band === 'ready_to_submit';
      }
      if (submittal_ready || rtr_required || voice_required) {
        rows.push({
          talent_id,
          requisition_id,
          submittal_ready,
          rtr_required,
          voice_required,
        });
      }
    }
    return rows;
  }

  async listInterviewsInWindow(
    ctx: DeskActorContext,
    window: DeskDayWindow,
  ): Promise<readonly DeskInterviewRow[]> {
    const rows = await this.interviews.listScheduledInWindowForRequisitions({
      tenant_id: ctx.tenant_id,
      from: new Date(window.start_iso),
      to: new Date(window.end_iso),
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((iv) => ({
      id: iv.id,
      scheduled_at: iv.scheduled_at,
      talent_record_id: iv.talent_record_id,
      requisition_id: iv.requisition_id,
      interview_type: iv.interview_type,
      round: iv.round,
      state: iv.state,
    }));
  }

  async listAwaitingClient(
    ctx: DeskActorContext,
  ): Promise<readonly DeskAwaitingRow[]> {
    const rows = await this.clientSelection.listInReviewForRequisitions({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((p) => ({
      id: p.id,
      talent_id: p.talent_id,
      requisition_id: p.requisition_id,
      created_at: p.created_at,
    }));
  }

  async listBlockedPlacements(
    ctx: DeskActorContext,
  ): Promise<readonly DeskBlockedPlacementRow[]> {
    const rows = await this.placements.listForActor({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows
      .filter((p) => p.state === 'BLOCKED')
      .map((p) => ({
        id: p.id,
        talent_record_id: p.talent_record_id,
        requisition_id: p.requisition_id,
        proposed_start_date:
          p.proposed_start_date === null
            ? null
            : p.proposed_start_date.toISOString().slice(0, 10),
      }));
  }

  async listExpiringOffers(
    ctx: DeskActorContext,
  ): Promise<readonly DeskOfferRow[]> {
    const rows = await this.offers.list({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((o) => ({
      id: o.id,
      talent_record_id: o.talent_record_id,
      requisition_id: o.requisition_id,
      state: o.state,
      offer_expires_at: o.offer_expires_at,
    }));
  }

  // Talent Draft Recovery §19 — the actor's own unpromoted intake drafts, narrowed
  // for the desk. needs_attention = FAILED/PARTIAL extraction (recruiter-safe
  // prose for the reason). NO derivation here — the service decides which rows are
  // desk-eligible (needs-attention OR stale ≥ 3 days).
  async listUnfinishedTalentForActor(
    ctx: DeskActorContext,
  ): Promise<readonly DeskUnfinishedTalentRow[]> {
    const rows = await this.talentIntake.listTalentIntakeDraftsForCreator({
      tenant_id: ctx.tenant_id,
      created_by: ctx.user_id,
      limit: LIST_LIMIT,
    });
    return rows
      .filter((d) => d.promoted_talent_record_id === null)
      .map((d) => {
        const needsAttention =
          d.processing_status === 'FAILED' || d.processing_status === 'PARTIAL';
        const fields =
          d.review_payload !== null &&
          typeof d.review_payload === 'object' &&
          'fields' in (d.review_payload as Record<string, unknown>)
            ? ((d.review_payload as { fields?: Record<string, { value?: unknown }> }).fields ?? {})
            : {};
        const str = (key: string): string => {
          const v = fields[key]?.value;
          return typeof v === 'string' ? v.trim() : '';
        };
        const name = `${str('first_name')} ${str('last_name')}`.trim();
        return {
          id: d.id,
          display_name: name === '' ? null : name,
          source_filename: d.source_filename,
          needs_attention: needsAttention,
          reason: needsAttention
            ? ((d.failure_detail as string | null) ?? "Couldn't read résumé")
            : null,
          last_touched_at:
            d.last_touched_at === null ? null : new Date(d.last_touched_at).toISOString(),
        };
      });
  }

  // Offer & Start §11 — the authoritative live pipeline-episode id per (talent, requisition),
  // via the Pipeline repo (ATS→Pipeline read, by UUID). Bounded to the pairs passed (the
  // Offer & Start exceptions); a pair with no live episode is omitted from the map.
  async resolveLiveEpisodeIds(
    ctx: DeskActorContext,
    pairs: readonly { talent_record_id: string; requisition_id: string }[],
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      pairs.map(async (p) => {
        const episode = await this.pipelines.findLiveEpisode({
          tenant_id: ctx.tenant_id,
          talent_record_id: p.talent_record_id,
          requisition_id: p.requisition_id,
        });
        if (episode !== null) out.set(`${p.talent_record_id}|${p.requisition_id}`, episode.id);
      }),
    );
    return out;
  }

  async resolveTalentNames(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.talent.findNamesByIds({
      tenant_id: ctx.tenant_id,
      ids: talent_ids,
    });
  }

  // CRM-7 (§11) — per-talent communication authority for the follow-up CTA.
  // can_call/can_email = contacting-consent permits (summary === 'contactable',
  // the Talent-360 recruitingPermitted rule) AND the channel exists. Two batch
  // reads (consent + channel presence); absent talent ⇒ both false.
  async resolveTalentContactability(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, { can_call: boolean; can_email: boolean }>> {
    const unique = [...new Set(talent_ids.filter((id) => id.length > 0))];
    if (unique.length === 0) return new Map();
    const [consent, channels] = await Promise.all([
      this.consent.findContactingConsentSummaryForTalentIds({
        tenant_id: ctx.tenant_id,
        talent_record_ids: unique,
      }),
      this.talent.findContactChannelsByIds({ tenant_id: ctx.tenant_id, ids: unique }),
    ]);
    const out = new Map<string, { can_call: boolean; can_email: boolean }>();
    for (const id of unique) {
      const permitted = consent.get(id) === 'contactable';
      const ch = channels.get(id);
      out.set(id, {
        can_call: permitted && (ch?.has_phone ?? false),
        can_email: permitted && (ch?.has_email ?? false),
      });
    }
    return out;
  }

  async resolveCompanyNames(
    ctx: DeskActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.companies.findNamesByIds({
      tenant_id: ctx.tenant_id,
      ids: company_ids,
    });
  }
}
