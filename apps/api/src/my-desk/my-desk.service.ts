import { Inject, Injectable } from '@nestjs/common';

import {
  agingDaysInTimeZone,
  classifyDueUrgency,
  comparePriorityItems,
  isoDateInTimeZone,
} from './my-desk.derivation.js';
import {
  MY_DESK_READ_PORT,
  type DeskActorContext,
  type DeskInterviewRow,
  type DeskTaskOwnerType,
  type DeskTaskRow,
  type DeskTaskType,
  type MyDeskReadPort,
} from './my-desk.ports.js';
import type {
  DeskExceptionView,
  DeskItemKind,
  DeskPriorityItemView,
  DeskRequisitionRowView,
  MyDeskView,
} from './dto/my-desk.view.js';

// The My Desk read COMPOSITION. It orchestrates existing domain reads (via the
// MyDeskReadPort) and projects them into MyDeskView using the pure derivation
// core — it creates no state, owns no invariant, and derives no verdict. All
// urgency/aging is computed against `timeZone` server-side (directive §38); the
// FE derives every card and tab count from the returned arrays (directive §14).

const DAY_MS = 86_400_000;
const OFFER_EXPIRY_WINDOW_DAYS = 7;

// task.type → recruiter queue kind. call/email/follow_up read as a follow-up;
// everything else is a plain task. (The rtr/submittal/engagement/client kinds
// are backend-increment-2, derived from pipeline/submittal/engagement state.)
const TASK_KIND: Record<DeskTaskType, DeskItemKind> = {
  follow_up: 'follow_up',
  call: 'follow_up',
  email: 'follow_up',
  interview: 'task',
  screen: 'task',
  consent: 'task',
  admin: 'task',
};

// task.owner_type → the FE route the "Open task" affordance navigates to (reuses
// the existing entity workspace — My Desk orchestrates, never re-implements).
const OWNER_ROUTE: Record<DeskTaskOwnerType, string | null> = {
  talent_record: '/talent',
  requisition: '/requisitions',
  company: '/companies',
  contact: null,
};

// Pipeline stages excluded from the live "in pipeline" tally (terminal).
const TERMINAL_PIPELINE_STATUSES = new Set([
  'not_in_consideration',
  'completed',
  'voided',
]);

// Offer states that can still be "expiring" (awaiting a talent response).
const OPEN_OFFER_STATES = new Set(['SENT', 'NEGOTIATION']);

// Interview states that count as scheduled-for-today.
const LIVE_INTERVIEW_STATES = new Set(['SCHEDULED', 'RESCHEDULED']);

function parseMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

@Injectable()
export class MyDeskService {
  constructor(
    @Inject(MY_DESK_READ_PORT) private readonly port: MyDeskReadPort,
  ) {}

  async compose(
    ctx: DeskActorContext,
    nowMs: number,
    timeZone: string,
  ): Promise<MyDeskView> {
    // The half-open UTC window covering the app-timezone civil "today", so the
    // interview read filters on a civil day, not a UTC day (directive §38).
    const todayIso = isoDateInTimeZone(nowMs, timeZone);
    const dayStartUtc = Date.parse(`${todayIso}T00:00:00Z`);
    const window = {
      start_iso: new Date(dayStartUtc - offsetGuardMs()).toISOString(),
      end_iso: new Date(dayStartUtc + DAY_MS + offsetGuardMs()).toISOString(),
    };

    const [
      tasks,
      requisitions,
      interviews,
      awaiting,
      blocked,
      offers,
    ] = await Promise.all([
      this.port.listMyTasks(ctx),
      this.port.listMyRequisitions(ctx),
      this.port.listInterviewsInWindow(ctx, window),
      this.port.listAwaitingClient(ctx),
      this.port.listBlockedPlacements(ctx),
      this.port.listExpiringOffers(ctx),
    ]);

    const reqIds = requisitions.map((r) => r.id);
    const pipelines =
      reqIds.length === 0
        ? []
        : await this.port.listPipelinesForRequisitions(ctx, reqIds);

    // Task→requisition enrichment: a talent-owned task adopts a requisition
    // ONLY when the talent sits on exactly one ACTIVE (non-terminal) pipeline in
    // the visible set — an unambiguous authoritative relationship. Two or more
    // active pipelines is ambiguous; we leave the context null rather than guess
    // (Architect ruling / directive §34: never invent context).
    const talentActiveReqs = new Map<string, Set<string>>();
    for (const p of pipelines) {
      if (TERMINAL_PIPELINE_STATUSES.has(p.status)) continue;
      const set = talentActiveReqs.get(p.talent_record_id) ?? new Set<string>();
      set.add(p.requisition_id);
      talentActiveReqs.set(p.talent_record_id, set);
    }
    const talentToReq = new Map<string, string | null>();
    for (const [talentId, reqs] of talentActiveReqs) {
      talentToReq.set(talentId, reqs.size === 1 ? ([...reqs][0] ?? null) : null);
    }

    // Interview day filter is re-applied server-side against the civil day (the
    // window is a coarse prefilter that may over-fetch at the UTC edges).
    const interviewsToday = interviews.filter(
      (iv) =>
        LIVE_INTERVIEW_STATES.has(iv.state) &&
        isoDateInTimeZone(Date.parse(iv.scheduled_at), timeZone) === todayIso,
    );

    // Expiring offers: still open, expiry known, within the window, not past.
    const expiringOffers = offers.filter((o) => {
      const exp = parseMs(o.offer_expires_at);
      if (exp === null || !OPEN_OFFER_STATES.has(o.state)) return false;
      if (classifyDueUrgency(exp, nowMs, timeZone) === 'overdue') return false;
      return agingDaysInTimeZone(nowMs, exp, timeZone) <= OFFER_EXPIRY_WINDOW_DAYS;
    });

    // One batched name/label resolution across every section that shows people.
    const reqLabel = new Map(
      requisitions.map((r) => [r.id, `REQ-${r.requisition_number}`]),
    );
    const talentIds = dedupe([
      ...tasks
        .filter((t) => t.owner_type === 'talent_record')
        .map((t) => t.owner_id),
      ...interviewsToday.map((iv) => iv.talent_record_id),
      ...awaiting.map((w) => w.talent_id),
      ...blocked.map((b) => b.talent_record_id),
      ...expiringOffers.map((o) => o.talent_record_id),
    ]);
    const [talentNames, companyNames] = await Promise.all([
      this.port.resolveTalentNames(ctx, talentIds),
      this.port.resolveCompanyNames(ctx, dedupe(requisitions.map((r) => r.company_id))),
    ]);

    const priority_items = tasks
      .map((t) =>
        this.toPriorityItem(t, nowMs, timeZone, reqLabel, talentNames, talentToReq),
      )
      .sort(comparePriorityItems);

    const interviews_today = interviewsToday
      .map((iv) => this.toInterview(iv, reqLabel, talentNames))
      .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));

    const awaiting_client = awaiting
      .map((w) => ({
        id: w.id,
        talent_id: w.talent_id,
        talent_name: talentNames.get(w.talent_id) ?? null,
        requisition_id: w.requisition_id,
        requisition_label: reqLabel.get(w.requisition_id) ?? null,
        reason: 'Awaiting client decision',
        waiting_days: agingDaysInTimeZone(Date.parse(w.created_at), nowMs, timeZone),
        since: w.created_at,
      }))
      .sort((a, b) =>
        b.waiting_days !== a.waiting_days
          ? b.waiting_days - a.waiting_days
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );

    const exceptions: DeskExceptionView[] = [
      ...blocked.map((b) => ({
        id: b.id,
        kind: 'pre_start_blocked' as const,
        severity: 'high' as const,
        title: `Pre-Start blocked · ${talentNames.get(b.talent_record_id) ?? 'talent'}`,
        body:
          b.proposed_start_date !== null
            ? `Pre-Start is blocked. Start date ${b.proposed_start_date} is at risk.`
            : 'Pre-Start is blocked and will not move on its own.',
        talent_id: b.talent_record_id,
        requisition_id: b.requisition_id,
        owned_by_me: true,
        owner_label: null,
        primary_action: null,
      })),
      ...expiringOffers.map((o) => ({
        id: o.id,
        kind: 'offer_expiring' as const,
        severity: 'medium' as const,
        title: `Offer expiring · ${talentNames.get(o.talent_record_id) ?? 'talent'}`,
        body: `Offer expires ${isoDateInTimeZone(Date.parse(o.offer_expires_at as string), timeZone)} with no response yet.`,
        talent_id: o.talent_record_id,
        requisition_id: o.requisition_id,
        owned_by_me: true,
        owner_label: null,
        primary_action: null,
      })),
    ];

    const requisitionRows = requisitions.map((r) =>
      this.toRequisitionRow(r, pipelines, nowMs, timeZone, companyNames),
    );

    return {
      generated_at: new Date(nowMs).toISOString(),
      server_date: todayIso,
      priority_items,
      interviews_today,
      awaiting_client,
      exceptions,
      requisitions: requisitionRows,
    };
  }

  private toPriorityItem(
    t: DeskTaskRow,
    nowMs: number,
    timeZone: string,
    reqLabel: ReadonlyMap<string, string | null>,
    talentNames: ReadonlyMap<string, string>,
    talentToReq: ReadonlyMap<string, string | null>,
  ): DeskPriorityItemView {
    const kind = t.type !== null ? TASK_KIND[t.type] : 'task';
    const isTalent = t.owner_type === 'talent_record';
    const talentName = isTalent ? (talentNames.get(t.owner_id) ?? null) : null;
    // Requisition context: a req-owned task IS its requisition; a talent-owned
    // task adopts its requisition only when unambiguous (single active pipeline).
    const requisitionId =
      t.owner_type === 'requisition'
        ? t.owner_id
        : isTalent
          ? (talentToReq.get(t.owner_id) ?? null)
          : null;
    const route = OWNER_ROUTE[t.owner_type];
    return {
      id: t.id,
      kind,
      talent_id: isTalent ? t.owner_id : null,
      talent_name: talentName,
      requisition_id: requisitionId,
      requisition_label:
        requisitionId !== null ? (reqLabel.get(requisitionId) ?? null) : null,
      // Label = the person when the task is about a talent, else the task title.
      label: talentName ?? t.title,
      // Reason = the task title (the FACT of what to do) when the label is the
      // person; empty otherwise (the title already occupies the label).
      reason: talentName !== null ? t.title : '',
      due_at: t.due_date,
      urgency: classifyDueUrgency(parseMs(t.due_date), nowMs, timeZone),
      primary_action:
        route === null
          ? null
          : { kind: 'open_task', label: 'Open task', href: `${route}/${t.owner_id}` },
    };
  }

  private toInterview(
    iv: DeskInterviewRow,
    reqLabel: ReadonlyMap<string, string | null>,
    talentNames: ReadonlyMap<string, string>,
  ) {
    return {
      id: iv.id,
      scheduled_at: iv.scheduled_at,
      talent_id: iv.talent_record_id,
      talent_name: talentNames.get(iv.talent_record_id) ?? null,
      requisition_id: iv.requisition_id,
      requisition_label: reqLabel.get(iv.requisition_id) ?? null,
      interview_type: iv.interview_type,
      round: iv.round,
      // The interview substrate carries no talent-confirmation flag — 'unknown'
      // is the honest value (directive §35 WIRED-WITH-LIMITATION).
      confirmation: 'unknown' as const,
    };
  }

  private toRequisitionRow(
    r: {
      id: string;
      requisition_number: number;
      title: string;
      company_id: string;
      status: string;
      created_at: string;
      is_hot: boolean;
    },
    pipelines: readonly { requisition_id: string; status: string }[],
    nowMs: number,
    timeZone: string,
    companyNames: ReadonlyMap<string, string>,
  ): DeskRequisitionRowView {
    const mine = pipelines.filter((p) => p.requisition_id === r.id);
    const pipeline_count = mine.filter(
      (p) => !TERMINAL_PIPELINE_STATUSES.has(p.status),
    ).length;
    const qualified_count = mine.filter((p) => p.status === 'qualified').length;
    return {
      id: r.id,
      code: `REQ-${r.requisition_number}`,
      title: r.title,
      client_name: companyNames.get(r.company_id) ?? null,
      days_open: agingDaysInTimeZone(Date.parse(r.created_at), nowMs, timeZone),
      status: r.status as DeskRequisitionRowView['status'],
      pipeline_count,
      qualified_count,
      // Downstream-owned (A7 seam) — composed in backend increment 2.
      with_client_count: 0,
      offer_count: 0,
      started_count: 0,
      signal:
        qualified_count > 0
          ? `${qualified_count} qualified`
          : pipeline_count > 0
            ? 'Sourcing — nobody qualified yet'
            : 'No pipeline yet',
    };
  }
}

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

// A small guard so the coarse UTC prefilter window cannot clip a civil day at
// any real timezone offset (max ±14h). The service re-applies the exact civil
// filter, so over-fetching at the edge is corrected — this only prevents
// under-fetching.
function offsetGuardMs(): number {
  return 14 * 60 * 60 * 1000;
}
