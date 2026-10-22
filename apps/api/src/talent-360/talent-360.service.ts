import { Inject, Injectable } from '@nestjs/common';
import { AramoError, isoDateInTimeZone } from '@aramo/common';
import {
  deriveClientWaitingDays,
  isInterviewToday,
} from '@aramo/client-selection';
import { ACTIVE_FLOW_STAGES } from '@aramo/pipeline';

import type { TalentRequisitionJourney } from '../talent-journey/dto/talent-journey.view.js';

import {
  TALENT_360_READ_PORT,
  type ActivityRow,
  type CommunicationRow,
  type EpisodeRow,
  type PipelineActivityRow,
  type RequisitionSummaryRow,
  type Talent360ActorContext,
  type Talent360ReadPort,
  type TalentCoreRow,
} from './talent-360.ports.js';
import {
  TALENT_360_DOCUMENT_PREVIEW_MAX_BYTES,
  TALENT_360_RECENT_ACTIVITY_LIMIT,
} from './talent-360.adapters.js';
import type {
  ActiveOpportunityView,
  AttentionItemView,
  ClosedOpportunityView,
  CommunicationPreviewView,
  TalentDocumentContentView,
  IdentityView,
  ProfileFactView,
  ProfileSkillView,
  RecentActivityItemView,
  RelationshipStripView,
  Talent360AuthorizedSections,
  Talent360View,
  TalentDocumentView,
  TalentTaskView,
} from './dto/talent-360.view.js';

// The Talent 360 read COMPOSITION. It orchestrates existing domain reads (via
// the Talent360ReadPort) and projects them into Talent360View — it creates no
// state, owns no invariant, and derives no verdict a domain does not already
// own (directive §4/§32). Every scope-gated section is composed ONLY when the
// caller holds the contributing domain scope (§17.8), so composition can never
// broaden access. Mirrors the My Desk composition precedent.

const ACTIVE_STAGES = new Set<string>(ACTIVE_FLOW_STAGES);
// Submittal states that count as a live submittal for the KPI (submitted to the
// client/ATS or confirmed there).
const SUBMITTED_STATES = new Set(['submitted_to_client', 'confirmed']);
// Offer states that count as a live offer (matches OfferRepository.countLive).
const LIVE_OFFER_STATES = new Set(['SENT', 'NEGOTIATION', 'ACCEPTED']);

// Recruiter-facing scope keys gating each composed section (directive §17.8).
const SCOPE = {
  pipeline: 'pipeline:read',
  task: 'task:read',
  activity: 'activity:read',
  communication: 'communication:read',
  document: 'document:read',
} as const;

// The honest recruiting-ready rule copy (HALT-1) — describes the ACTUAL landed
// predicate, never the prototype's stronger consent/identity promise.
export const RECRUITING_READY_RULE =
  'A live record with at least one contact channel and a work authorization on record. Worked out by Aramo from the record; never set by hand.';

interface JourneyBundle {
  readonly episode: EpisodeRow;
  readonly journey: TalentRequisitionJourney;
  readonly requisition: RequisitionSummaryRow | null;
}

@Injectable()
export class Talent360Service {
  constructor(
    @Inject(TALENT_360_READ_PORT) private readonly port: Talent360ReadPort,
  ) {}

  async compose(
    ctx: Talent360ActorContext,
    talent_id: string,
    nowMs: number,
    timeZone: string,
  ): Promise<Talent360View> {
    const core = await this.port.loadTalent(ctx, talent_id);
    if (core === null) {
      throw new AramoError('NOT_FOUND', 'Talent not found in tenant', 404, {
        requestId: ctx.request_id,
      });
    }

    const authorized: Talent360AuthorizedSections = {
      opportunities: ctx.scopes.has(SCOPE.pipeline),
      attention: ctx.scopes.has(SCOPE.pipeline),
      tasks: ctx.scopes.has(SCOPE.task),
      activity: ctx.scopes.has(SCOPE.activity) || ctx.scopes.has(SCOPE.communication),
      communications: ctx.scopes.has(SCOPE.communication),
      documents: ctx.scopes.has(SCOPE.document),
      // Identity outcomes ride the same talent:read the route already required.
      identity: true,
    };

    const generated_at = new Date(nowMs).toISOString();
    const server_date = isoDateInTimeZone(nowMs, timeZone);

    // A superseded record is never rehydrated as a live workspace (directive
    // §17.10 / §23). Return the header (carrying the survivor pointer so the FE
    // redirects) with every composed section suppressed.
    if (core.record_status === 'superseded') {
      return this.supersededView(core, generated_at, server_date);
    }

    // ---- Opportunities + KPI-strip counts + attention (pipeline:read) --------
    let bundles: JourneyBundle[] = [];
    let closedEpisodes: EpisodeRow[] = [];
    // ATS-QA-1 D1/D2 — the episodes whose requisition the viewer may see (the
    // same predicate the opportunities use); their milestones feed the activity.
    let visibleEpisodes: readonly EpisodeRow[] = [];
    let reqMap: ReadonlyMap<string, RequisitionSummaryRow> = new Map();
    let companyNames: ReadonlyMap<string, string> = new Map();
    let userNames: ReadonlyMap<string, string> = new Map();
    let dispositionReasons: ReadonlyMap<string, string> = new Map();
    if (authorized.opportunities) {
      const episodes = await this.port.listEpisodes(ctx, talent_id);
      const active = episodes.filter((e) => ACTIVE_STAGES.has(e.status));
      closedEpisodes = episodes.filter((e) => !ACTIVE_STAGES.has(e.status));

      const journeys = await Promise.all(
        active.map((e) => this.port.composeJourney(ctx, e.id)),
      );
      const reqIds = dedupe(episodes.map((e) => e.requisition_id));
      reqMap = await this.port.resolveRequisitions(ctx, reqIds);
      visibleEpisodes = episodes.filter((e) => reqMap.has(e.requisition_id));
      const companyIds = dedupe(
        [...reqMap.values()].map((r) => r.company_id),
      );
      // The record's own owner ("Record added by") rides in the same batch.
      const ownerIds = dedupe(
        [
          ...[...reqMap.values()].flatMap((r) => [r.recruiter_id, r.owner_id]),
          core.owner_id,
        ].filter((x): x is string => x !== null),
      );
      [companyNames, userNames, dispositionReasons] = await Promise.all([
        this.port.resolveCompanyNames(ctx, companyIds),
        this.port.resolveUserNames(ctx, ownerIds),
        // CRM-5 §9.5 — terminal reasons for the closed episodes only.
        this.port.resolveDispositionReasons(ctx, closedEpisodes.map((e) => e.id)),
      ]);
      bundles = active.map((episode, i) => ({
        episode,
        journey: journeys[i]!,
        requisition: reqMap.get(episode.requisition_id) ?? null,
      }));
    } else if (core.owner_id !== null) {
      // No pipeline read — still resolve the record owner's name for "Record added by".
      userNames = await this.port.resolveUserNames(ctx, [core.owner_id]);
    }

    // Interview scheduled instants (only for active journeys that reached an
    // INTERVIEW stage) — the KPI/attention "today" derivation needs the instant.
    const interviewByPipeline = authorized.opportunities
      ? await this.resolveInterviewInstants(ctx, bundles)
      : new Map<string, { scheduled_at: string; state: string }>();

    const opportunities = authorized.opportunities
      ? {
          active: bundles.map((b) =>
            this.toActiveOpportunity(b, interviewByPipeline, companyNames, userNames, nowMs, timeZone),
          ),
          closed: closedEpisodes.map((e) =>
            this.toClosedOpportunity(
              e,
              reqMap.get(e.requisition_id) ?? null,
              companyNames,
              dispositionReasons.get(e.id) ?? null,
            ),
          ),
        }
      : null;

    const relationship_strip = this.toRelationshipStrip(
      authorized,
      bundles,
      interviewByPipeline,
      nowMs,
      timeZone,
      // last-contact resolved below (communication-scoped)
      authorized.communications ? await this.port.lastContact(ctx, talent_id) : null,
    );

    const attention = authorized.attention
      ? this.deriveAttention(bundles, interviewByPipeline, core, nowMs, timeZone)
      : null;

    // ---- Tasks (task:read) ---------------------------------------------------
    const tasks: readonly TalentTaskView[] | null = authorized.tasks
      ? (await this.port.listTasks(ctx, talent_id)).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          due_date: t.due_date,
          requisition_id: null,
          requisition_label: null,
        }))
      : null;

    // ---- Recent activity (activity:read ∪ communication:read) ----------------
    const recent_activity = authorized.activity
      ? await this.composeRecentActivity(ctx, talent_id, authorized, reqMap, visibleEpisodes, timeZone)
      : null;

    // ---- Documents (document:read) -------------------------------------------
    const documents = authorized.documents
      ? await this.composeDocuments(ctx, talent_id, reqMap)
      : null;

    // ---- Identity outcomes (talent:read) -------------------------------------
    const identity: IdentityView | null = authorized.identity
      ? await this.port.loadIdentityOutcomes(ctx, talent_id)
      : null;

    // ---- Contactability (consent authority) ----------------------------------
    const consentSummary = await this.port.loadConsentSummary(ctx, talent_id);
    const recruitingPermitted = consentSummary === 'contactable';

    // ---- Profile + relationship (talent:read, always present) ----------------
    const workHistory = await this.port.listWorkHistory(ctx, talent_id);
    const profile = this.toProfile(core, workHistory);
    const relationship = this.toRelationship(
      core,
      bundles,
      closedEpisodes,
      userNames,
      reqMap,
    );

    return {
      generated_at,
      server_date,
      header: {
        talent_id: core.id,
        first_name: core.first_name,
        last_name: core.last_name,
        display_name: `${core.first_name} ${core.last_name}`.trim(),
        title: core.title,
        location: locationLabel(core.city, core.state),
        experience_summary: null,
        email: core.email1,
        phone: core.phone_cell,
        work_authorization: core.work_authorization,
        desired_compensation: core.desired_pay,
        engagement_type: core.engagement_type,
        availability: { status: core.availability_status, detail: null },
        recruiting_ready: { ready: core.recruiting_ready, rule: RECRUITING_READY_RULE },
        contactability: {
          summary: consentSummary,
          recruiting_permitted: recruitingPermitted,
          // Per-channel consent is not exposed as a batch read today; the
          // recruiting-contact permit is the authoritative signal (§6.6). The
          // channel rows degrade to the recruiting permit rather than inferring
          // from email/phone presence (documented Slice-A limitation).
          email_permitted: recruitingPermitted,
          phone_permitted: recruitingPermitted,
          sms_permitted: false,
        },
        actions: {
          can_email: recruitingPermitted && core.email1 !== null,
          can_call: recruitingPermitted && core.phone_cell !== null,
          can_add_to_requisition: authorized.opportunities,
          can_log_activity: authorized.activity,
          can_edit_profile: true,
        },
        record_status: 'live',
        superseded_by_record_id: null,
      },
      relationship_strip,
      opportunities,
      attention,
      tasks,
      recent_activity,
      documents,
      identity,
      profile,
      relationship,
      authorized_sections: authorized,
    };
  }

  // --- opportunity composition ---------------------------------------------

  private async resolveInterviewInstants(
    ctx: Talent360ActorContext,
    bundles: readonly JourneyBundle[],
  ): Promise<Map<string, { scheduled_at: string; state: string }>> {
    const out = new Map<string, { scheduled_at: string; state: string }>();
    await Promise.all(
      bundles.map(async (b) => {
        const processId = interviewProcessId(b.journey);
        if (processId === null) return;
        const iv = await this.port.findLatestInterview(ctx, processId);
        if (iv !== null) {
          out.set(b.episode.id, { scheduled_at: iv.scheduled_at, state: iv.state });
        }
      }),
    );
    return out;
  }

  private toActiveOpportunity(
    b: JourneyBundle,
    interviews: ReadonlyMap<string, { scheduled_at: string; state: string }>,
    companyNames: ReadonlyMap<string, string>,
    userNames: ReadonlyMap<string, string>,
    nowMs: number,
    timeZone: string,
  ): ActiveOpportunityView {
    const req = b.requisition;
    const code = req !== null ? `REQ-${req.requisition_number}` : 'REQ-—';
    const ownerId = req?.recruiter_id ?? req?.owner_id ?? null;
    const iv = interviews.get(b.episode.id) ?? null;
    return {
      pipeline_id: b.episode.id,
      requisition_id: b.episode.requisition_id,
      requisition_code: code,
      client_name: req !== null ? (companyNames.get(req.company_id) ?? null) : null,
      role_title: req?.title ?? null,
      stage: b.journey.current_journey_stage,
      contextual_state: contextualState(b.journey, iv, nowMs, timeZone),
      age_label: ageLabel(b.journey, iv, nowMs, timeZone),
      owner_label: ownerId !== null ? (userNames.get(ownerId) ?? null) : null,
      next_action: nextOpportunityAction(b.journey),
      journey: b.journey,
      // §11 — the active opportunity deep-links to the person × requisition Offer & Start journey
      // (pipeline-episode-keyed), NOT the bare requisition; the person axis is preserved.
      open_journey_href: `/offer-start/${b.episode.id}`,
    };
  }

  private toClosedOpportunity(
    e: EpisodeRow,
    req: RequisitionSummaryRow | null,
    companyNames: ReadonlyMap<string, string>,
    reason: string | null,
  ): ClosedOpportunityView {
    return {
      pipeline_id: e.id,
      requisition_id: e.requisition_id,
      requisition_code: req !== null ? `REQ-${req.requisition_number}` : 'REQ-—',
      client_name: req !== null ? (companyNames.get(req.company_id) ?? null) : null,
      role_title: req?.title ?? null,
      outcome: terminalOutcome(e.status),
      reason,
      closed_at: e.updated_at,
      open_journey_href: `/requisitions/${e.requisition_id}`,
    };
  }

  private toRelationshipStrip(
    authorized: Talent360AuthorizedSections,
    bundles: readonly JourneyBundle[],
    interviews: ReadonlyMap<string, { scheduled_at: string; state: string }>,
    nowMs: number,
    timeZone: string,
    lastContact: { at: string; channel: string } | null,
  ): RelationshipStripView {
    if (!authorized.opportunities) {
      return {
        active_opportunities: null,
        submittals: null,
        interviews_today: null,
        offers: null,
        assignments: null,
        last_contact: lastContact,
      };
    }
    let submittals = 0;
    let interviewsToday = 0;
    let offers = 0;
    let assignments = 0;
    for (const b of bundles) {
      const s = b.journey.sub_states;
      if (s.submittal_state !== null && SUBMITTED_STATES.has(s.submittal_state)) submittals += 1;
      if (s.offer_state !== null && LIVE_OFFER_STATES.has(s.offer_state)) offers += 1;
      if (s.placement_state === 'STARTED') assignments += 1;
      const iv = interviews.get(b.episode.id);
      if (
        iv !== undefined &&
        isInterviewToday({
          state: iv.state,
          scheduled_at_ms: Date.parse(iv.scheduled_at),
          now_ms: nowMs,
          time_zone: timeZone,
        })
      ) {
        interviewsToday += 1;
      }
    }
    return {
      active_opportunities: bundles.length,
      submittals,
      interviews_today: interviewsToday,
      offers,
      assignments,
      last_contact: lastContact,
    };
  }

  private deriveAttention(
    bundles: readonly JourneyBundle[],
    interviews: ReadonlyMap<string, { scheduled_at: string; state: string }>,
    core: TalentCoreRow,
    nowMs: number,
    timeZone: string,
  ): readonly AttentionItemView[] {
    const items: AttentionItemView[] = [];
    for (const b of bundles) {
      const req = b.requisition;
      const label = req !== null ? `REQ-${req.requisition_number}` : null;
      const iv = interviews.get(b.episode.id);
      if (
        iv !== undefined &&
        isInterviewToday({
          state: iv.state,
          scheduled_at_ms: Date.parse(iv.scheduled_at),
          now_ms: nowMs,
          time_zone: timeZone,
        })
      ) {
        items.push({
          id: `interview:${b.episode.id}`,
          kind: 'interview',
          kicker: 'TODAY',
          title: `${b.requisition?.title ?? 'Client'} interview`,
          subtitle: label,
          requisition_id: b.episode.requisition_id,
          requisition_label: label,
          action: { kind: 'open_interview', label: 'Open', href: `/requisitions/${b.episode.requisition_id}` },
        });
      }
      const waiting = clientWaitDays(b.journey, nowMs, timeZone);
      if (waiting !== null) {
        items.push({
          id: `waiting:${b.episode.id}`,
          kind: 'waiting',
          kicker: `WAITING ${waiting} ${waiting === 1 ? 'DAY' : 'DAYS'}`,
          title: `${b.requisition?.title ?? 'Client'} hasn't responded`,
          subtitle: label,
          requisition_id: b.episode.requisition_id,
          requisition_label: label,
          action: { kind: 'follow_up', label: 'Follow up', href: `/requisitions/${b.episode.requisition_id}` },
        });
      }
    }
    return items;
  }

  // --- communication preview ------------------------------------------------

  /**
   * The full sent email behind a Recent-activity row. Same visibility rules as
   * the list: the Talent must be readable, the email must be this Talent's
   * (`subject` association), and when it is regarding requisitions at least one
   * must be visible to the viewer. Every refusal is the same tenant-safe 404 so
   * existence is never disclosed. Email channel only.
   */
  async previewCommunication(
    ctx: Talent360ActorContext,
    talent_id: string,
    interaction_id: string,
  ): Promise<CommunicationPreviewView> {
    const notFound = (): AramoError =>
      new AramoError('NOT_FOUND', 'Communication not found for this Talent', 404, {
        requestId: ctx.request_id,
      });
    const core = await this.port.loadTalent(ctx, talent_id);
    if (core === null) throw notFound();
    const row = await this.port.loadCommunicationPreview(ctx, talent_id, interaction_id);
    if (row === null || row.channel !== 'email') throw notFound();
    const [reqs, names] = await Promise.all([
      this.port.resolveRequisitions(ctx, row.requisition_ids),
      this.port.resolveUserNames(ctx, row.initiated_by_id !== null ? [row.initiated_by_id] : []),
    ]);
    const req = row.requisition_ids.map((id) => reqs.get(id)).find((r) => r !== undefined) ?? null;
    if (row.requisition_ids.length > 0 && req === null) throw notFound();
    return {
      id: row.id,
      channel: row.channel,
      direction: row.direction,
      subject: row.subject,
      body: row.body,
      from_address: row.from_address,
      to_address: row.to_address,
      sent_at: row.created_at,
      sender_label: row.initiated_by_id !== null ? (names.get(row.initiated_by_id) ?? null) : null,
      requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
    };
  }

  // --- document preview (read-only) ----------------------------------------

  /**
   * A Talent document's file for the read-only preview. The Talent must be
   * readable and the document SUBJECT-associated to it; when the document is
   * regarding requisitions, at least one must be visible to the viewer. Every
   * refusal is the same tenant-safe 404. Nothing is recorded (read-only by PO
   * ruling); a file over the preview cap is refused (422, reason too_large_for_preview).
   */
  async documentContent(
    ctx: Talent360ActorContext,
    talent_id: string,
    document_id: string,
  ): Promise<TalentDocumentContentView> {
    const notFound = (): AramoError =>
      new AramoError('NOT_FOUND', 'Document not found for this Talent', 404, {
        requestId: ctx.request_id,
      });
    const core = await this.port.loadTalent(ctx, talent_id);
    if (core === null) throw notFound();
    const row = await this.port.loadDocumentContent(ctx, talent_id, document_id);
    if (row === null) throw notFound();
    if (row.regarding_requisition_ids.length > 0) {
      const reqs = await this.port.resolveRequisitions(ctx, row.regarding_requisition_ids);
      if (reqs.size === 0) throw notFound();
    }
    if (row.byte_size > TALENT_360_DOCUMENT_PREVIEW_MAX_BYTES) {
      throw new AramoError('VALIDATION_ERROR', 'This document is too large to preview', 422, {
        requestId: ctx.request_id,
        details: {
          reason: 'too_large_for_preview',
          byte_size: row.byte_size,
          max_bytes: TALENT_360_DOCUMENT_PREVIEW_MAX_BYTES,
        },
      });
    }
    const bytes = await row.readBytes();
    return {
      document_id: row.document_id,
      file_name: row.title,
      mime_type: row.mime_type,
      byte_size: bytes.byteLength,
      content_base64: bytes.toString('base64'),
    };
  }

  // --- recent activity ------------------------------------------------------

  private async composeRecentActivity(
    ctx: Talent360ActorContext,
    talent_id: string,
    authorized: Talent360AuthorizedSections,
    reqMap: ReadonlyMap<string, RequisitionSummaryRow>,
    visibleEpisodes: readonly EpisodeRow[],
    timeZone: string,
  ): Promise<Talent360View['recent_activity']> {
    // Pipeline milestones need BOTH activity:read and pipeline:read (the episode
    // set is only composed under pipeline:read) — composition never broadens.
    const readMilestones =
      ctx.scopes.has(SCOPE.activity) && authorized.opportunities && visibleEpisodes.length > 0;
    const [acts, milestones, comms] = await Promise.all([
      ctx.scopes.has(SCOPE.activity)
        ? this.port.listRecentActivity(ctx, talent_id, TALENT_360_RECENT_ACTIVITY_LIMIT)
        : Promise.resolve([] as readonly ActivityRow[]),
      readMilestones
        ? this.port.listPipelineActivity(ctx, visibleEpisodes, TALENT_360_RECENT_ACTIVITY_LIMIT)
        : Promise.resolve([] as readonly PipelineActivityRow[]),
      authorized.communications
        ? this.port.listRecentCommunications(ctx, talent_id, TALENT_360_RECENT_ACTIVITY_LIMIT)
        : Promise.resolve([] as readonly CommunicationRow[]),
    ]);

    // Requisition context for communication rows. resolveRequisitions applies the
    // authoritative visibility predicate, so a requisition the viewer cannot see
    // is simply absent — its label is never shown and (below) the row's subject
    // and preview are withheld rather than leaking hidden requisition content.
    const extraReqIds = dedupe(comms.flatMap((c) => c.requisition_ids)).filter(
      (id) => !reqMap.has(id),
    );
    const actorIds = dedupe(
      [
        ...acts.map((a) => a.created_by_id),
        ...milestones.map((m) => m.created_by_id),
        ...comms.map((c) => c.initiated_by_id),
      ].filter(
        (x): x is string => x !== null,
      ),
    );
    const [extraReqs, actorNames] = await Promise.all([
      this.port.resolveRequisitions(ctx, extraReqIds),
      this.port.resolveUserNames(ctx, actorIds),
    ]);
    const visibleReqs = new Map<string, RequisitionSummaryRow>([...reqMap, ...extraReqs]);

    const merged: RecentActivityItemView[] = [
      ...acts.map((a) => activityToItem(a, actorNames)),
      ...milestones.map((m) => milestoneToItem(m, reqMap, actorNames)),
      ...comms.map((c) => commToItem(c, visibleReqs, actorNames, timeZone)),
    ].sort((x, y) => Date.parse(y.occurred_at) - Date.parse(x.occurred_at));

    const window = merged.slice(0, TALENT_360_RECENT_ACTIVITY_LIMIT);
    const counts: Record<string, number> = {};
    for (const it of window) counts[it.category] = (counts[it.category] ?? 0) + 1;
    return {
      items: window,
      category_counts: counts,
      has_more: merged.length > window.length,
    };
  }

  // --- documents ------------------------------------------------------------

  private async composeDocuments(
    ctx: Talent360ActorContext,
    talent_id: string,
    reqMap: ReadonlyMap<string, RequisitionSummaryRow>,
  ): Promise<Talent360View['documents']> {
    const docs = await this.port.listDocuments(ctx, talent_id);
    const key_documents: TalentDocumentView[] = docs.map((d) => {
      const req =
        d.regarding_requisition_id !== null
          ? (reqMap.get(d.regarding_requisition_id) ?? null)
          : null;
      const signed = d.status === 'EXECUTED';
      return {
        id: d.id,
        kind: documentKind(d.document_type_name, req),
        requisition_id: d.regarding_requisition_id,
        requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
        meta: d.title,
        signed,
        signed_at: signed ? d.executed_at : null,
      };
    });
    return { key_documents, total: key_documents.length };
  }

  // --- profile / relationship ----------------------------------------------

  private toProfile(
    core: TalentCoreRow,
    workHistory: Awaited<ReturnType<Talent360ReadPort['listWorkHistory']>>,
  ): Talent360View['profile'] {
    const facts: ProfileFactView[] = [];
    if (core.availability_status !== null) {
      facts.push({ label: 'Availability', value: core.availability_status, source: null });
    }
    if (core.desired_pay !== null) {
      facts.push({ label: 'Compensation', value: core.desired_pay, source: null });
    }
    if (core.work_authorization !== null) {
      facts.push({ label: 'Work authorization', value: core.work_authorization, source: null });
    }
    const loc = locationLabel(core.city, core.state);
    if (loc !== null) facts.push({ label: 'Location', value: loc, source: null });
    if (core.engagement_type !== null) {
      facts.push({ label: 'Engagement', value: core.engagement_type, source: null });
    }
    const skills: ProfileSkillView[] = splitSkills(core.key_skills).map((label) => ({
      label,
      // Skill verification is a trust-band outcome not composed in Slice A; the
      // Overview shows the skill without a verified check rather than faking one.
      verified: false,
    }));
    return {
      summary: null,
      facts,
      skills,
      work_history: workHistory.map((w) => ({
        role: w.role_title,
        organization: w.employer_name,
        span: spanLabel(w.start_date, w.end_date),
        source: w.source,
      })),
    };
  }

  private toRelationship(
    core: TalentCoreRow,
    bundles: readonly JourneyBundle[],
    closedEpisodes: readonly EpisodeRow[],
    userNames: ReadonlyMap<string, string>,
    reqMap: ReadonlyMap<string, RequisitionSummaryRow>,
  ): Talent360View['relationship'] {
    let submittals = 0;
    let interviews = 0;
    let placements = 0;
    for (const b of bundles) {
      const s = b.journey.sub_states;
      if (s.submittal_state !== null && SUBMITTED_STATES.has(s.submittal_state)) submittals += 1;
      if (s.interview_state !== null) interviews += 1;
      if (s.placement_state === 'STARTED') placements += 1;
    }
    const requisitions = bundles.length + closedEpisodes.length;

    // "Also working with" = the recruiters attributed to the Talent's active
    // opportunities (the authoritative per-requisition owner), excluding the
    // viewing recruiter (HALT-2). Never inferred from activity; owner_id is
    // provenance only.
    const alsoWorking = new Map<string, { user_id: string; requisition_id: string; requisition_label: string | null }>();
    for (const b of bundles) {
      const ownerId = b.requisition?.recruiter_id ?? b.requisition?.owner_id ?? null;
      if (ownerId === null) continue;
      if (!alsoWorking.has(ownerId)) {
        const req = reqMap.get(b.episode.requisition_id) ?? null;
        alsoWorking.set(ownerId, {
          user_id: ownerId,
          requisition_id: b.episode.requisition_id,
          requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
        });
      }
    }

    // CRM-5 §9.4 — "Worked with before": the recruiters attributed to the
    // Talent's CLOSED episodes (via the authoritative per-requisition owner in
    // reqMap), minus anyone already surfaced as actively working with them.
    // Historical relationship — never inferred from activity, never an owner.
    const workedBefore = new Map<string, { user_id: string; requisition_id: string; requisition_label: string | null }>();
    for (const e of closedEpisodes) {
      const req = reqMap.get(e.requisition_id) ?? null;
      const ownerId = req?.recruiter_id ?? req?.owner_id ?? null;
      if (ownerId === null) continue;
      if (alsoWorking.has(ownerId) || workedBefore.has(ownerId)) continue;
      workedBefore.set(ownerId, {
        user_id: ownerId,
        requisition_id: e.requisition_id,
        requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
      });
    }
    return {
      history: {
        known_since: core.created_at,
        requisitions,
        submittals,
        interviews,
        placements,
      },
      ownership: {
        owner_provenance:
          core.owner_id === null
            ? null
            : { user_id: core.owner_id, name: userNames.get(core.owner_id) ?? null },
        also_working_with: [...alsoWorking.values()].map((a) => ({
          user_id: a.user_id,
          name: userNames.get(a.user_id) ?? null,
          requisition_id: a.requisition_id,
          requisition_label: a.requisition_label,
        })),
        worked_with_before: [...workedBefore.values()].map((a) => ({
          user_id: a.user_id,
          name: userNames.get(a.user_id) ?? null,
          requisition_id: a.requisition_id,
          requisition_label: a.requisition_label,
        })),
        source: core.source,
        source_channel: null,
      },
    };
  }

  private supersededView(
    core: TalentCoreRow,
    generated_at: string,
    server_date: string,
  ): Talent360View {
    const authorized: Talent360AuthorizedSections = {
      opportunities: false,
      attention: false,
      tasks: false,
      activity: false,
      communications: false,
      documents: false,
      identity: false,
    };
    return {
      generated_at,
      server_date,
      header: {
        talent_id: core.id,
        first_name: core.first_name,
        last_name: core.last_name,
        display_name: `${core.first_name} ${core.last_name}`.trim(),
        title: core.title,
        location: locationLabel(core.city, core.state),
        experience_summary: null,
        email: core.email1,
        phone: core.phone_cell,
        work_authorization: core.work_authorization,
        desired_compensation: core.desired_pay,
        engagement_type: core.engagement_type,
        availability: { status: core.availability_status, detail: null },
        recruiting_ready: { ready: false, rule: RECRUITING_READY_RULE },
        contactability: {
          summary: 'do_not_contact',
          recruiting_permitted: false,
          email_permitted: false,
          phone_permitted: false,
          sms_permitted: false,
        },
        actions: {
          can_email: false,
          can_call: false,
          can_add_to_requisition: false,
          can_log_activity: false,
          can_edit_profile: false,
        },
        record_status: 'superseded',
        superseded_by_record_id: core.superseded_by_record_id,
      },
      relationship_strip: {
        active_opportunities: null,
        submittals: null,
        interviews_today: null,
        offers: null,
        assignments: null,
        last_contact: null,
      },
      opportunities: null,
      attention: null,
      tasks: null,
      recent_activity: null,
      documents: null,
      identity: null,
      profile: { summary: null, facts: [], skills: [], work_history: [] },
      relationship: {
        history: { known_since: core.created_at, requisitions: 0, submittals: 0, interviews: 0, placements: 0 },
        ownership: { owner_provenance: null, also_working_with: [], worked_with_before: [], source: core.source, source_channel: null },
      },
      authorized_sections: authorized,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure derivation helpers
// ---------------------------------------------------------------------------

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

function locationLabel(city: string | null, state: string | null): string | null {
  if (city !== null && state !== null) return `${city}, ${state}`;
  return city ?? state ?? null;
}

function splitSkills(key_skills: string | null): string[] {
  if (key_skills === null) return [];
  return key_skills
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function spanLabel(start: string | null, end: string | null): string {
  const s = start !== null ? start.slice(0, 4) : '—';
  const e = end !== null ? end.slice(0, 4) : 'present';
  return `${s} – ${e}`;
}

// The client-selection process id backing an INTERVIEW journey stage (its
// source_object_id), or null when the journey never reached interview.
function interviewProcessId(journey: TalentRequisitionJourney): string | null {
  const stage = journey.stages.find((s) => s.stage === 'INTERVIEW');
  return stage?.source_object_id ?? null;
}

// Journey-shape adapter onto the canonical "waiting on client" semantic: it
// extracts the authoritative inputs (selection_state + the CLIENT_REVIEW stage's
// occurred_at = ClientSelectionProcess.created_at) and delegates — it does NOT
// re-decide the waiting state or recompute the age.
function clientWaitDays(
  journey: TalentRequisitionJourney,
  nowMs: number,
  timeZone: string,
): number | null {
  const stage = journey.stages.find((s) => s.stage === 'CLIENT_REVIEW');
  return deriveClientWaitingDays({
    selection_state: journey.sub_states.selection_state,
    since_ms: stage?.occurred_at === undefined ? null : Date.parse(stage.occurred_at),
    now_ms: nowMs,
    time_zone: timeZone,
  });
}

function contextualState(
  journey: TalentRequisitionJourney,
  iv: { scheduled_at: string; state: string } | null,
  nowMs: number,
  timeZone: string,
): string | null {
  if (
    iv !== null &&
    isInterviewToday({
      state: iv.state,
      scheduled_at_ms: Date.parse(iv.scheduled_at),
      now_ms: nowMs,
      time_zone: timeZone,
    })
  ) {
    return 'Client interview today';
  }
  const waiting = clientWaitDays(journey, nowMs, timeZone);
  if (waiting !== null) {
    return `Waiting for client · ${waiting} ${waiting === 1 ? 'day' : 'days'}`;
  }
  return null;
}

function ageLabel(
  journey: TalentRequisitionJourney,
  iv: { scheduled_at: string; state: string } | null,
  nowMs: number,
  timeZone: string,
): string | null {
  void iv;
  const waiting = clientWaitDays(journey, nowMs, timeZone);
  return waiting !== null ? `${waiting}d` : null;
}

// The single most-relevant next action for an active opportunity — reuses the
// journey composer's owner-attributed actions (the owning domain's existing
// command), never a client-side business rule.
function nextOpportunityAction(
  journey: TalentRequisitionJourney,
): ActiveOpportunityView['next_action'] {
  const first = journey.actions[0];
  if (first === undefined) return null;
  return { kind: first.action, label: first.action, href: null };
}

function terminalOutcome(status: string): string {
  switch (status) {
    case 'not_in_consideration':
      return 'Not selected';
    case 'completed':
      return 'Completed';
    case 'voided':
      return 'Removed';
    default:
      return status;
  }
}

function documentKind(
  typeName: string,
  req: RequisitionSummaryRow | null,
): string {
  if (req !== null) return `${typeName} · ${req.title}`;
  return typeName;
}

function activityToItem(
  a: ActivityRow,
  actorNames: ReadonlyMap<string, string>,
): RecentActivityItemView {
  return {
    id: `activity:${a.id}`,
    occurred_at: a.created_at,
    category: activityCategory(a.type),
    title: activityTitle(a.type),
    body: a.notes,
    requisition_id: null,
    requisition_label: null,
    actor_label: a.created_by_id !== null ? (actorNames.get(a.created_by_id) ?? null) : null,
    channel: null,
    preview_id: null,
  };
}

// ATS-QA-1 D1/D2 — a pipeline milestone on a visible requisition. The body is the
// durable system note verbatim (historical stage keys preserved); ats-web's
// formatActivityNote renders it with the recruiter-facing stage labels.
function milestoneToItem(
  m: PipelineActivityRow,
  reqMap: ReadonlyMap<string, RequisitionSummaryRow>,
  actorNames: ReadonlyMap<string, string>,
): RecentActivityItemView {
  const req = reqMap.get(m.requisition_id) ?? null;
  return {
    id: `activity:${m.id}`,
    occurred_at: m.created_at,
    category: activityCategory('pipeline_status_change'),
    title: activityTitle('pipeline_status_change'),
    body: m.notes,
    requisition_id: m.requisition_id,
    requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
    actor_label: m.created_by_id !== null ? (actorNames.get(m.created_by_id) ?? null) : null,
    channel: null,
    preview_id: null,
  };
}

function commToItem(
  c: CommunicationRow,
  visibleReqs: ReadonlyMap<string, RequisitionSummaryRow>,
  actorNames: ReadonlyMap<string, string>,
  timeZone: string,
): RecentActivityItemView {
  const req =
    c.requisition_ids.map((id) => visibleReqs.get(id)).find((r) => r !== undefined) ?? null;
  // Regarding a requisition the viewer cannot see → withhold the subject and the
  // preview (they carry that requisition's content); the bare event still shows.
  const restricted = c.requisition_ids.length > 0 && req === null;
  const subject =
    !restricted && c.subject !== null && c.subject.trim().length > 0 ? c.subject.trim() : null;
  let body: string | null = null;
  if (c.channel === 'meeting') {
    const parts = [subject, meetingWindow(c.started_at, c.ended_at, timeZone)].filter(
      (x): x is string => x !== null,
    );
    body = parts.length > 0 ? parts.join(' — ') : null;
  } else if (subject !== null) {
    body = `“${subject}”`;
  }
  return {
    id: `comm:${c.id}`,
    occurred_at: c.created_at,
    category: 'communications',
    title: commTitle(c),
    body,
    requisition_id: req?.id ?? null,
    requisition_label: req !== null ? `REQ-${req.requisition_number}` : null,
    actor_label: c.initiated_by_id !== null ? (actorNames.get(c.initiated_by_id) ?? null) : null,
    channel: c.channel,
    preview_id: c.channel === 'email' && !restricted ? c.id : null,
  };
}

// A meeting row is never "sent": it is a scheduled Outlook event (scheduled/
// rescheduled/cancelled) or a create-link-only meeting link (`created`).
function commTitle(c: CommunicationRow): string {
  if (c.channel === 'meeting') {
    switch (c.status) {
      case 'scheduled':
        return 'Meeting scheduled';
      case 'rescheduled':
        return 'Meeting rescheduled';
      case 'cancelled':
        return 'Meeting cancelled';
      case 'created':
        return 'Meeting link created';
      default:
        return 'Meeting';
    }
  }
  return c.direction === 'inbound' ? `${channelNoun(c.channel)} received` : `${channelNoun(c.channel)} sent`;
}

// "Tue, Oct 14, 2:00 PM – 2:30 PM EDT" in the app timezone; null without a start.
function meetingWindow(start: string | null, end: string | null, timeZone: string): string | null {
  if (start === null) return null;
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return null;
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(s);
  const time = (d: Date, withZone: boolean): string =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      ...(withZone ? { timeZoneName: 'short' as const } : {}),
    }).format(d);
  const e = end === null ? null : new Date(end);
  if (e === null || Number.isNaN(e.getTime())) return `${day}, ${time(s, true)}`;
  return `${day}, ${time(s, false)} – ${time(e, true)}`;
}

function channelNoun(channel: string): string {
  switch (channel) {
    case 'voice':
      return 'Voice call';
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    case 'meeting':
      return 'Meeting';
    default:
      return 'Message';
  }
}

function activityCategory(type: string): string {
  switch (type) {
    case 'pipeline_status_change':
      return 'requisitions';
    case 'call':
    case 'email_logged':
      return 'communications';
    case 'note':
      return 'requisitions';
    default:
      return 'requisitions';
  }
}

function activityTitle(type: string): string {
  switch (type) {
    case 'pipeline_status_change':
      return 'Stage changed';
    case 'call':
      return 'Call logged';
    case 'email_logged':
      return 'Email logged';
    case 'note':
      return 'Note added';
    default:
      return 'Activity';
  }
}

