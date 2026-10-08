import { Inject, Injectable, Logger } from '@nestjs/common';
import { agingDaysInTimeZone, isoDateInTimeZone } from '@aramo/common';
import {
  CLIENT_WAITING_STATE,
  deriveClientWaitingDays,
  isInterviewToday,
} from '@aramo/client-selection';
import { deriveOfferTiming } from '@aramo/placement';

import {
  classifyDueUrgency,
  comparePriorityItems,
} from './my-desk.derivation.js';
import {
  MY_DESK_READ_PORT,
  type DeskActorContext,
  type DeskInterviewRow,
  type DeskReadinessRow,
  type DeskRequisitionCounts,
  type DeskTaskOwnerType,
  type DeskTaskRow,
  type DeskTaskType,
  type MyDeskReadPort,
} from './my-desk.ports.js';
import type {
  DeskActionView,
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
// Talent Draft Recovery §2.5/§19 — fixed 3-day staleness threshold (no tenant
// setting) for surfacing an untouched unfinished Talent on My Desk.
const UNFINISHED_STALE_DAYS = 3;

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

function parseMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

@Injectable()
export class MyDeskService {
  private readonly logger = new Logger(MyDeskService.name);

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
      unfinishedDrafts,
    ] = await Promise.all([
      this.port.listMyTasks(ctx),
      this.port.listMyRequisitions(ctx),
      this.port.listInterviewsInWindow(ctx, window),
      this.port.listAwaitingClient(ctx),
      this.port.listBlockedPlacements(ctx),
      this.port.listExpiringOffers(ctx),
      this.port.listUnfinishedTalentForActor(ctx),
    ]);

    const reqIds = requisitions.map((r) => r.id);

    // The only talents needing task→requisition enrichment are the owners of
    // talent-owned tasks — a bounded set, NOT the whole pipeline table.
    const taskTalentIds = dedupe(
      tasks
        .filter((t) => t.owner_type === 'talent_record')
        .map((t) => t.owner_id),
    );

    const [counts, activeReqsByTalent, readinessRows] = await Promise.all([
      reqIds.length === 0
        ? (new Map<string, DeskRequisitionCounts>() as ReadonlyMap<
            string,
            DeskRequisitionCounts
          >)
        : this.port.countsForRequisitions(ctx, reqIds),
      taskTalentIds.length === 0
        ? (new Map<string, readonly string[]>() as ReadonlyMap<
            string,
            readonly string[]
          >)
        : this.port.activeRequisitionsByTalent(ctx, taskTalentIds),
      reqIds.length === 0
        ? ([] as readonly DeskReadinessRow[])
        : this.port
            .listQualifiedReadiness(
              ctx,
              requisitions.map((r) => ({ id: r.id, company_id: r.company_id })),
            )
            // Section-level resilience (directive §28): the derived work kinds
            // are a best-effort enrichment composed across several domains
            // (incl. the Redis-backed engagement gate). If that heavier read
            // fails, degrade to no derived items rather than failing the whole
            // desk — the recruiter still sees tasks, counts, interviews,
            // awaiting-client and exceptions.
            .catch((err: unknown) => {
              this.logger.warn(
                `my-desk: qualified-readiness read failed, degrading derived kinds: ${String(
                  err,
                )}`,
              );
              return [] as readonly DeskReadinessRow[];
            }),
    ]);

    // Task→requisition enrichment: adopt a requisition ONLY when the talent
    // sits on exactly ONE active pipeline (unambiguous); two or more is
    // ambiguous → leave null rather than guess (Architect ruling / directive §34).
    const talentToReq = new Map<string, string | null>();
    for (const [talentId, reqs] of activeReqsByTalent) {
      talentToReq.set(talentId, reqs.length === 1 ? (reqs[0] ?? null) : null);
    }

    // Interview day filter is re-applied server-side against the civil day (the
    // window is a coarse prefilter that may over-fetch at the UTC edges). The
    // today-ness decision is the canonical client-selection semantic.
    const interviewsToday = interviews.filter((iv) =>
      isInterviewToday({
        state: iv.state,
        scheduled_at_ms: Date.parse(iv.scheduled_at),
        now_ms: nowMs,
        time_zone: timeZone,
      }),
    );

    // Expiring offers: the canonical offer-timing semantic decides "expiring soon"
    // (awaiting response, expiry known, not past, within the warning window).
    const expiringOffers = offers.filter(
      (o) =>
        deriveOfferTiming({
          state: o.state,
          offer_expires_at: o.offer_expires_at,
          now_ms: nowMs,
          time_zone: timeZone,
        }).expiring_soon,
    );

    // Offer & Start §11 — resolve the authoritative journey key (live pipeline episode) for each
    // expiring-offer exception so its CTA deep-links into the single person × requisition journey.
    const offerEpisodeIds = await this.port.resolveLiveEpisodeIds(
      ctx,
      expiringOffers.map((o) => ({ talent_record_id: o.talent_record_id, requisition_id: o.requisition_id })),
    );

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
      ...readinessRows.map((r) => r.talent_id),
    ]);
    // CRM-7 (§11) — communication authority for the follow-up CTA, batched over
    // the talent-owned task owners (taskTalentIds, above) — the only rows whose
    // CTA can be Call/Email.
    const [talentNames, companyNames, contactability] = await Promise.all([
      this.port.resolveTalentNames(ctx, talentIds),
      this.port.resolveCompanyNames(ctx, dedupe(requisitions.map((r) => r.company_id))),
      this.port.resolveTalentContactability(ctx, taskTalentIds),
    ]);

    // The queue = task-derived items + domain-derived work items (submittal-
    // ready / RTR-required / voice-required), ranked by the one deterministic
    // comparator (urgency → kind precedence → due → id).
    const priority_items = [
      ...tasks.map((t) =>
        this.toPriorityItem(t, nowMs, timeZone, reqLabel, talentNames, talentToReq, contactability),
      ),
      ...toDerivedItems(readinessRows, reqLabel, talentNames),
    ].sort(comparePriorityItems);

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
        // Canonical "waiting on client" age (the port returns only CLIENT_REVIEW
        // rows, so the state gate always passes; ?? 0 guards an unparseable date).
        waiting_days:
          deriveClientWaitingDays({
            selection_state: CLIENT_WAITING_STATE,
            since_ms: Date.parse(w.created_at),
            now_ms: nowMs,
            time_zone: timeZone,
          }) ?? 0,
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
      ...expiringOffers.map((o) => {
        // Deep-link the CTA into the journey ONLY when an authoritative live episode resolved
        // (narrow §11 — never a reconstructed key); otherwise no CTA (unchanged prior behavior).
        const pid = offerEpisodeIds.get(`${o.talent_record_id}|${o.requisition_id}`) ?? null;
        return {
          id: o.id,
          kind: 'offer_expiring' as const,
          severity: 'medium' as const,
          title: `Offer expiring · ${talentNames.get(o.talent_record_id) ?? 'talent'}`,
          body: `Offer expires ${isoDateInTimeZone(Date.parse(o.offer_expires_at as string), timeZone)} with no response yet.`,
          talent_id: o.talent_record_id,
          requisition_id: o.requisition_id,
          owned_by_me: true,
          owner_label: null,
          primary_action:
            pid !== null
              ? { kind: 'continue_offer_start' as const, label: 'Continue in Offer & Start', href: `/offer-start/${pid}` }
              : null,
        };
      }),
      // Talent Draft Recovery §19 — an unfinished Talent surfaces ONLY when it
      // needs attention (couldn't read the résumé) OR has gone stale (untouched
      // ≥ 3 days). Own drafts only. No "Mark done" — it clears automatically when
      // promoted / discarded / touched, because the next compose simply omits it.
      ...unfinishedDrafts
        .map((d) => {
          const touchedMs = d.last_touched_at === null ? null : Date.parse(d.last_touched_at);
          const staleDays =
            touchedMs === null ? 0 : Math.floor((nowMs - touchedMs) / DAY_MS);
          const stale = staleDays >= UNFINISHED_STALE_DAYS;
          return { d, stale, staleDays };
        })
        .filter(({ d, stale }) => d.needs_attention || stale)
        .map(({ d, stale, staleDays }) => {
          const label = d.display_name ?? d.source_filename ?? 'résumé';
          return {
            id: d.id,
            kind: 'unfinished_talent' as const,
            severity: d.needs_attention ? ('high' as const) : ('medium' as const),
            title: `Finish adding ${label}`,
            body: d.needs_attention
              ? (d.reason ?? "Couldn't read résumé")
              : `Untouched ${staleDays} days`,
            // A draft is NOT a TalentRecord — never fabricate a Talent identity.
            talent_id: null,
            requisition_id: null,
            owned_by_me: true,
            owner_label: null,
            primary_action: {
              kind: 'continue_draft' as const,
              label: 'Continue',
              href: `/talent/new?draft=${encodeURIComponent(d.id)}&from=in-progress`,
            },
          };
        }),
    ];

    const requisitionRows = requisitions.map((r) =>
      this.toRequisitionRow(r, counts, nowMs, timeZone, companyNames),
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
    contactability: ReadonlyMap<string, { can_call: boolean; can_email: boolean }>,
  ): DeskPriorityItemView {
    const kind = t.type !== null ? TASK_KIND[t.type] : 'task';
    const isTalent = t.owner_type === 'talent_record';
    const talentName = isTalent ? (talentNames.get(t.owner_id) ?? null) : null;
    // Requisition context (CRM-6 §10 rule 5 — EXPLICIT-first, derived-second): a
    // req-owned task IS its requisition; otherwise the task's explicit
    // requisition_id wins; a talent-owned task falls back to its requisition
    // only when unambiguous (single active pipeline). Historical/current tasks
    // with no explicit context keep the derivation — backward-compatible.
    const requisitionId =
      t.owner_type === 'requisition'
        ? t.owner_id
        : (t.requisition_id ??
          (isTalent ? (talentToReq.get(t.owner_id) ?? null) : null));
    const route = OWNER_ROUTE[t.owner_type];
    // The fallback "Open" affordance (§11 "Open talent / Open task") — unchanged
    // label; the route already lands on the talent/owner surface.
    const openAction: DeskActionView | null =
      route === null ? null : { kind: 'open_task', label: 'Open task', href: `${route}/${t.owner_id}` };
    // CRM-7 (§11) CTA rule — a Task defines WHAT is due; it does NOT grant a
    // communication action. The CTA comes from communication authority:
    //   follow_up + requisition + email permitted  → Email (requisition-contextual)
    //   follow_up + no requisition + voice permitted → Call
    //   otherwise                                    → Open talent / Open task
    // Non-follow_up tasks keep the plain Open affordance.
    let primary_action: DeskActionView | null = openAction;
    if (kind === 'follow_up' && isTalent) {
      const c = contactability.get(t.owner_id) ?? { can_call: false, can_email: false };
      if (requisitionId !== null) {
        primary_action = c.can_email ? { kind: 'email', label: 'Email', href: null } : openAction;
      } else {
        primary_action = c.can_call ? { kind: 'call', label: 'Call', href: null } : openAction;
      }
    }
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
      primary_action,
      task_id: t.id, // this row IS a Task — Done/Snooze act on it
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
    counts: ReadonlyMap<string, DeskRequisitionCounts>,
    nowMs: number,
    timeZone: string,
    companyNames: ReadonlyMap<string, string>,
  ): DeskRequisitionRowView {
    const c = counts.get(r.id) ?? EMPTY_COUNTS;
    return {
      id: r.id,
      code: `REQ-${r.requisition_number}`,
      title: r.title,
      client_name: companyNames.get(r.company_id) ?? null,
      days_open: agingDaysInTimeZone(Date.parse(r.created_at), nowMs, timeZone),
      status: r.status as DeskRequisitionRowView['status'],
      pipeline_count: c.pipeline,
      qualified_count: c.qualified,
      // Downstream-owned (A7 seam) — composed server-side via owning-domain
      // groupBy reads (Increment-2), FE renders as-is.
      with_client_count: c.with_client,
      offer_count: c.offer,
      started_count: c.started,
      signal: requisitionSignal(c),
    };
  }
}

const EMPTY_COUNTS: DeskRequisitionCounts = {
  pipeline: 0,
  qualified: 0,
  with_client: 0,
  offer: 0,
  started: 0,
};

// FACTS-only operational signal (directive §22), derived from the authoritative
// counts. Most-advanced-stage-first so the recruiter sees the sharpest signal.
function requisitionSignal(c: DeskRequisitionCounts): string {
  if (c.started > 0) return `${c.started} started`;
  if (c.offer > 0) return `${c.offer} at offer`;
  if (c.with_client > 0) return `${c.with_client} with client`;
  if (c.qualified > 0) return `${c.qualified} qualified`;
  if (c.pipeline > 0) return 'Sourcing — nobody qualified yet';
  return 'No pipeline yet';
}

// Map the per-(talent, requisition) readiness rows into domain-derived work
// items. FACTS-only reason lines; each CTA enters an EXISTING owning-domain
// route (the submittal flow / talent detail) — My Desk orchestrates, never
// mutates. The three flags are naturally mutually exclusive with submittal_ready
// (a ready talent has RTR + engagement satisfied), so no dedup rule is needed;
// a not-ready talent may legitimately carry both an RTR and a voice item (two
// distinct obligations). Item ids are stable + deterministic.
function toDerivedItems(
  rows: readonly DeskReadinessRow[],
  reqLabel: ReadonlyMap<string, string>,
  talentNames: ReadonlyMap<string, string>,
): DeskPriorityItemView[] {
  const items: DeskPriorityItemView[] = [];
  for (const row of rows) {
    const talentName = talentNames.get(row.talent_id) ?? null;
    const base = {
      talent_id: row.talent_id,
      talent_name: talentName,
      requisition_id: row.requisition_id,
      requisition_label: reqLabel.get(row.requisition_id) ?? null,
      label: talentName ?? 'Talent',
      due_at: null,
      urgency: 'today' as const,
      task_id: null, // DERIVED work item — no backing Task (no Done/Snooze)
    };
    if (row.submittal_ready) {
      items.push({
        ...base,
        id: `submittal:${row.requisition_id}:${row.talent_id}`,
        kind: 'submittal',
        reason: 'Ready to submit — all Submittal Policy checks met.',
        primary_action: {
          kind: 'submit_to_client',
          label: 'Submit to client',
          href: `/talent/${row.talent_id}/submittal/${row.requisition_id}`,
        },
      });
    }
    if (row.rtr_required) {
      items.push({
        ...base,
        id: `rtr:${row.requisition_id}:${row.talent_id}`,
        kind: 'rtr',
        reason: 'Qualified · Right to Represent not sent.',
        primary_action: {
          kind: 'send_rtr',
          label: 'Send RTR',
          href: `/talent/${row.talent_id}/submittal/${row.requisition_id}`,
        },
      });
    }
    if (row.voice_required) {
      items.push({
        ...base,
        id: `voice:${row.requisition_id}:${row.talent_id}`,
        kind: 'engagement',
        reason: 'Email logged · voice engagement required before submittal.',
        primary_action: {
          kind: 'log_voice_call',
          label: 'Log voice call',
          href: `/talent/${row.talent_id}`,
        },
      });
    }
  }
  return items;
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
