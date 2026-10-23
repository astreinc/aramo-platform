import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DISPUTE_OPEN_STATUSES,
  DISPUTE_SLA,
  DISPUTE_STATUSES,
  parseReferenceParams,
  validateOpenDisputeRequest,
  validateRespondDisputeRequest,
  validateTenantDisputeActionRequest,
  validateWithdrawDisputeRequest,
  type Contributor,
  type DisputeActionResponse,
  type DisputeSlaView,
  type DisputeStatementAuthor,
  type DisputeStatus,
  type PortalDisputeListResponse,
  type PortalDisputeSummary,
  type PortalDisputeView,
  type TenantDisputeListResponse,
  type TenantDisputeSummary,
  type TenantDisputeView,
} from '@aramo/intelligence-contracts';

import { assertionVisibleTo, crossTenantReadEnabled, isOwnAssertion, isTiOriginated } from '../access/tenant-view.js';
import { survivingSubject } from '../identity/identity-resolution.service.js';
import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import { PROJECTION_TRIGGER, type ProjectionTrigger } from '../projection/projection.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type Assertion,
  type AssertionDispute,
  type ExternalTalentReference,
  type IntelligenceRepositories,
  type IntelligenceUnitOfWork,
  type TenantKey,
} from '../repositories/types.js';
import { RETIRED_ASSERTION_STATUSES, type AssertionStatus, type DisputeEventType } from '../vocabulary.js';

import {
  decodeCursor,
  encodeCursor,
  pageLimit,
  refused,
  requireActiveReference,
  requireEntitledTenant,
  tenantActor,
  tenantReferencesOn,
} from './lifecycle-access.js';

// ATI-SEP-1 T10 M-4 (Addendum A3 T10-2) — talent-raised disputes, rebuilt as a
// Talent Intelligence evidence-lifecycle model. A dispute targets ONE Assertion;
// it is opened by the talent through a reference they hold (the portal / ATS
// records it on the talent's behalf). The legacy state machine and SLA clocks are
// kept; the legacy per-tenant work-item fan-out collapses to one dispute because
// the disputed assertion is one global Golden row.
//
//   open (talent)        → OPEN (no assertion change; one open dispute per assertion — idempotent)
//   triage (tenant)      OPEN → UNDER_REVIEW, assertion → DISPUTED (event DISPUTED)
//                        retired assertion → RESOLVED_NO_TRANSITION
//   request-info         a TENANT statement on the thread (no status change)
//   correct (tenant)     UNDER_REVIEW → RESOLVED_CORRECTED, assertion DISPUTED → REVOKED (event CORRECTED)
//   uphold (tenant)      UNDER_REVIEW → RESOLVED_UPHELD,    assertion DISPUTED → VALID   (event DISPUTE_RESOLVED)
//                        assertion no longer DISPUTED → RESOLVED_NO_TRANSITION
//   extend (tenant)      reinvestigation_due_at + 15 days, once
//   respond (talent)     a TALENT statement while open (replaying the latest is a no-op)
//   withdraw (talent)    → WITHDRAWN; a triaged (DISPUTED) assertion → VALID (event DISPUTE_RESOLVED)
// Every transition appends an AssertionDisputeEvent; every assertion change an
// AssertionEvent; the projection is rebuilt after commit (has_open_dispute).
//
// Tenant visibility: the tenant must be entitled and hold an ACTIVE reference on
// the disputed subject; with TI_CROSS_TENANT_READ_ENABLED=false it sees only
// disputes of assertions it contributed or TI originated. Anything else is 404.

const DAY_MS = 86_400_000;
const OPEN = DISPUTE_OPEN_STATUSES as readonly string[];
const RETIRED = RETIRED_ASSERTION_STATUSES as readonly string[];
const PORTAL_LIST_LIMIT = 200;
export const DISPUTE_WITHDRAWAL_JUSTIFICATION = 'talent withdrawal: dispute withdrawn by the talent';

const hashStatement = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function slaOf(d: AssertionDispute): DisputeSlaView {
  return {
    triage_due_at: d.triage_due_at.toISOString(),
    summary_due_at: d.summary_due_at.toISOString(),
    reinvestigation_due_at: d.reinvestigation_due_at.toISOString(),
    reinvestigation_extended_at: iso(d.reinvestigation_extended_at),
    ccpa_due_at: iso(d.ccpa_due_at),
    ccpa_extended_due_at: iso(d.ccpa_extended_due_at),
  };
}

export function disputeSla(now: Date) {
  const t = now.getTime();
  return {
    triage_due_at: new Date(t + DISPUTE_SLA.triageDueDays * DAY_MS),
    summary_due_at: new Date(t + DISPUTE_SLA.summaryDueDays * DAY_MS),
    reinvestigation_due_at: new Date(t + DISPUTE_SLA.reinvestigationDueDays * DAY_MS),
    // CCPA 45 (+45 recorded tenant-side when taken) — the initial clock starts at open.
    ccpa_due_at: new Date(t + DISPUTE_SLA.ccpaInitialDays * DAY_MS),
    ccpa_extended_due_at: null,
  };
}

interface TenantContext {
  tenant: TenantKey;
  dispute: AssertionDispute;
  assertion: Assertion;
  subjectId: string;
  refs: ExternalTalentReference[];
}

type ActionTx = { response: DisputeActionResponse; changedSubject: string | null };

@Injectable()
export class DisputeService {
  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    @Optional() @Inject(PROJECTION_TRIGGER) private readonly projection?: ProjectionTrigger,
  ) {}

  // ── portal (talent) side ───────────────────────────────────────────────────

  async open(body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<PortalDisputeView> {
    const v = validateOpenDisputeRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    const req = v.value;
    return this.uow.run(
      async (repos) => {
        const { subject, reference } = await requireActiveReference(repos, principal, req.portal_context, { entitled: false });
        const assertion = await this.ownedAssertion(repos, req.assertion_id, subject.id);
        if (RETIRED.includes(assertion.current_status)) throw refused('ASSERTION_NOT_DISPUTABLE');
        const existing = await repos.disputes.findOpenForAssertion(assertion.id);
        if (existing !== null) return this.portalView(repos, existing, assertion); // one open dispute per assertion
        const dispute = await repos.disputes.create({
          assertion_id: assertion.id,
          opened_via_reference_id: reference.id,
          opened_at: now,
          ...disputeSla(now),
        });
        await this.statement(repos, dispute.id, 'TALENT', req.statement);
        await this.event(repos, dispute, 'OPENED', { to: 'OPEN', actor: talentActor(reference) });
        return this.portalView(repos, dispute, assertion);
      },
      { lockKeys: [`dispute-assertion:${req.assertion_id}`] },
    );
  }

  async listForPortal(rawReferences: unknown, principal: IngestPrincipal, status: unknown): Promise<PortalDisputeListResponse> {
    const statuses = parseStatusFilter(status, 'all');
    return this.uow.run(async (repos) => {
      const subjects = await this.portalSubjects(repos, rawReferences, principal);
      const rows = await repos.disputes.listBySubjects([...subjects], { statuses, limit: PORTAL_LIST_LIMIT });
      const items: PortalDisputeSummary[] = [];
      for (const d of rows) {
        const a = await repos.assertions.findById(d.assertion_id);
        if (a !== null) items.push(this.portalSummary(d, a));
      }
      return { items };
    });
  }

  async getForPortal(id: string, rawReferences: unknown, principal: IngestPrincipal): Promise<PortalDisputeView> {
    return this.uow.run(async (repos) => {
      const subjects = await this.portalSubjects(repos, rawReferences, principal);
      const { dispute, assertion } = await this.portalDispute(repos, id, subjects);
      return this.portalView(repos, dispute, assertion);
    });
  }

  async respond(id: string, body: unknown, principal: IngestPrincipal): Promise<PortalDisputeView> {
    const v = validateRespondDisputeRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    return this.uow.run(
      async (repos) => {
        const { subject, reference } = await requireActiveReference(repos, principal, v.value.portal_context, { entitled: false });
        const { dispute, assertion } = await this.portalDispute(repos, id, new Set([subject.id]));
        if (!OPEN.includes(dispute.status)) throw refused('DISPUTE_NOT_OPEN');
        const statements = await repos.disputes.listStatements(dispute.id);
        const last = statements[statements.length - 1];
        if (last === undefined || last.author !== 'TALENT' || last.statement_hash !== hashStatement(v.value.statement)) {
          await this.statement(repos, dispute.id, 'TALENT', v.value.statement);
          await this.event(repos, dispute, 'STATEMENT_ADDED', { actor: talentActor(reference) });
        }
        return this.portalView(repos, dispute, assertion);
      },
      { lockKeys: [`dispute:${id}`] },
    );
  }

  async withdraw(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<PortalDisputeView> {
    const v = validateWithdrawDisputeRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    let changed: string | null = null;
    const view = await this.uow.run(
      async (repos) => {
        const { subject, reference } = await requireActiveReference(repos, principal, v.value.portal_context, { entitled: false });
        const { dispute, assertion } = await this.portalDispute(repos, id, new Set([subject.id]));
        if (!OPEN.includes(dispute.status)) return this.portalView(repos, dispute, assertion); // idempotent: already terminal
        const actor = v.value.actor !== undefined ? `talent:${v.value.actor}` : talentActor(reference);
        // Only a triaged dispute moved the assertion; an untriaged one never left its status.
        if (dispute.status === 'UNDER_REVIEW' && (await this.move(repos, assertion, 'DISPUTED', 'VALID', 'DISPUTE_RESOLVED', actor, {
          dispute_id: dispute.id,
          outcome: 'WITHDRAWN',
          justification: DISPUTE_WITHDRAWAL_JUSTIFICATION,
        }))) {
          changed = subject.id;
        }
        const next = await repos.disputes.update(dispute.id, { status: 'WITHDRAWN', withdrawn_at: now, resolved_at: now });
        await this.event(repos, dispute, 'WITHDRAWN', { to: 'WITHDRAWN', actor });
        return this.portalView(repos, next, assertion);
      },
      { lockKeys: [`dispute:${id}`] },
    );
    if (changed !== null) await this.projection?.subjectsChanged([changed]);
    return view;
  }

  // ── tenant side ────────────────────────────────────────────────────────────

  async listForTenant(
    sourceTenantId: string,
    principal: IngestPrincipal,
    query: { status?: unknown; cursor?: unknown; limit?: unknown },
  ): Promise<TenantDisputeListResponse> {
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: sourceTenantId };
    const statuses = parseStatusFilter(query.status, 'open');
    const after = decodeCursor(query.cursor);
    const limit = pageLimit(query.limit);
    return this.uow.run(async (repos) => {
      await requireEntitledTenant(repos, principal, tenant);
      const rows = await repos.disputes.listForTenant(tenant, { crossTenant: crossTenantReadEnabled(), statuses, after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const items: TenantDisputeSummary[] = [];
      for (const d of page) {
        const a = await repos.assertions.findById(d.assertion_id);
        if (a === null) continue;
        const subject = await survivingSubject(repos, a.subject_id);
        items.push(this.tenantSummary(d, a, await tenantReferencesOn(repos, subject.id, tenant), tenant));
      }
      const last = page[page.length - 1];
      return { items, next_cursor: rows.length > limit && last ? encodeCursor({ at: last.opened_at, id: last.id }) : null };
    });
  }

  async getForTenant(sourceTenantId: string, id: string, principal: IngestPrincipal): Promise<TenantDisputeView> {
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: sourceTenantId };
    return this.uow.run(async (repos) => this.tenantView(repos, await this.tenantContext(repos, principal, tenant, id)));
  }

  triage(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<DisputeActionResponse> {
    return this.tenantAction(id, body, 'forbidden', principal, async (repos, ctx, actor) => {
      const { dispute, assertion } = ctx;
      if (dispute.status !== 'OPEN') return { response: { dispute_id: dispute.id, status: dispute.status as DisputeStatus }, changedSubject: null };
      if (RETIRED.includes(assertion.current_status)) return this.noTransition(repos, ctx, actor, 'assertion not disputable', null, now);
      if (assertion.current_status !== 'DISPUTED') {
        const moved = await this.move(repos, assertion, assertion.current_status as AssertionStatus, 'DISPUTED', 'DISPUTED', actor, { dispute_id: dispute.id });
        if (!moved) return this.noTransition(repos, ctx, actor, 'assertion not disputable', null, now);
      }
      await repos.disputes.update(dispute.id, { status: 'UNDER_REVIEW', triaged_at: now });
      await this.event(repos, dispute, 'TRIAGED', { to: 'UNDER_REVIEW', actor, tenant: ctx.tenant });
      return { response: { dispute_id: dispute.id, status: 'UNDER_REVIEW' }, changedSubject: ctx.subjectId };
    });
  }

  requestInfo(id: string, body: unknown, principal: IngestPrincipal): Promise<DisputeActionResponse> {
    return this.tenantAction(id, body, 'required', principal, async (repos, ctx, actor, note) => {
      await this.statement(repos, ctx.dispute.id, 'TENANT', note as string);
      await this.event(repos, ctx.dispute, 'INFO_REQUESTED', { actor, tenant: ctx.tenant });
      return { response: { dispute_id: ctx.dispute.id, status: ctx.dispute.status as DisputeStatus }, changedSubject: null };
    });
  }

  correct(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<DisputeActionResponse> {
    return this.dispose(id, body, principal, 'RESOLVED_CORRECTED', now);
  }

  uphold(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<DisputeActionResponse> {
    return this.dispose(id, body, principal, 'RESOLVED_UPHELD', now);
  }

  extend(id: string, body: unknown, principal: IngestPrincipal, now: Date = new Date()): Promise<DisputeActionResponse> {
    return this.tenantAction(id, body, 'forbidden', principal, async (repos, ctx, actor) => {
      const { dispute } = ctx;
      if (dispute.reinvestigation_extended_at !== null) throw refused('DISPUTE_EXTENSION_USED');
      const due = new Date(dispute.reinvestigation_due_at.getTime() + DISPUTE_SLA.reinvestigationExtensionDays * DAY_MS);
      await repos.disputes.update(dispute.id, { reinvestigation_due_at: due, reinvestigation_extended_at: now });
      await this.event(repos, dispute, 'EXTENDED', { actor, tenant: ctx.tenant, details: { reinvestigation_due_at: due.toISOString() } });
      return { response: { dispute_id: dispute.id, status: dispute.status as DisputeStatus }, changedSubject: null };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private dispose(
    id: string,
    body: unknown,
    principal: IngestPrincipal,
    outcome: 'RESOLVED_CORRECTED' | 'RESOLVED_UPHELD',
    now: Date,
  ): Promise<DisputeActionResponse> {
    return this.tenantAction(id, body, 'required', principal, async (repos, ctx, actor, note) => {
      const { dispute, assertion } = ctx;
      if (dispute.status === 'OPEN') throw refused('DISPUTE_NOT_UNDER_REVIEW');
      if (dispute.status !== 'UNDER_REVIEW') return { response: { dispute_id: dispute.id, status: dispute.status as DisputeStatus }, changedSubject: null };
      const corrected = outcome === 'RESOLVED_CORRECTED';
      const moved =
        assertion.current_status === 'DISPUTED' &&
        (await this.move(repos, assertion, 'DISPUTED', corrected ? 'REVOKED' : 'VALID', corrected ? 'CORRECTED' : 'DISPUTE_RESOLVED', actor, {
          dispute_id: dispute.id,
          outcome,
          justification: note as string,
        }));
      if (!moved) return this.noTransition(repos, ctx, actor, 'assertion not in DISPUTED state', note as string, now);
      await repos.disputes.update(dispute.id, { status: outcome, resolution_note: note as string, resolved_at: now });
      await this.event(repos, dispute, corrected ? 'CORRECTED' : 'UPHELD', { to: outcome, actor, tenant: ctx.tenant });
      return { response: { dispute_id: dispute.id, status: outcome }, changedSubject: ctx.subjectId };
    });
  }

  private async tenantAction(
    id: string,
    body: unknown,
    note: 'required' | 'forbidden',
    principal: IngestPrincipal,
    fn: (repos: IntelligenceRepositories, ctx: TenantContext, actor: string, note: string | undefined) => Promise<ActionTx>,
  ): Promise<DisputeActionResponse> {
    const v = validateTenantDisputeActionRequest(body, note);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    const tenant = { source_system_id: principal.source_system_id, source_tenant_id: v.value.source_tenant_id };
    const tx = await this.uow.run(
      async (repos) => {
        const ctx = await this.tenantContext(repos, principal, tenant, id);
        return fn(repos, ctx, tenantActor(tenant, v.value.actor), v.value.note);
      },
      { lockKeys: [`dispute:${id}`] },
    );
    if (tx.changedSubject !== null) await this.projection?.subjectsChanged([tx.changedSubject]);
    return tx.response;
  }

  private async noTransition(
    repos: IntelligenceRepositories,
    ctx: TenantContext,
    actor: string,
    reason: string,
    note: string | null,
    now: Date,
  ): Promise<ActionTx> {
    await repos.disputes.update(ctx.dispute.id, {
      status: 'RESOLVED_NO_TRANSITION',
      no_transition_reason: reason,
      resolved_at: now,
      ...(note !== null ? { resolution_note: note } : {}),
    });
    await this.event(repos, ctx.dispute, 'NO_TRANSITION', { to: 'RESOLVED_NO_TRANSITION', actor, tenant: ctx.tenant, details: { reason } });
    return { response: { dispute_id: ctx.dispute.id, status: 'RESOLVED_NO_TRANSITION' }, changedSubject: null };
  }

  /** Guarded assertion transition + its AssertionEvent. False when the status had moved. */
  private async move(
    repos: IntelligenceRepositories,
    assertion: Assertion,
    from: AssertionStatus,
    to: AssertionStatus,
    eventType: 'DISPUTED' | 'DISPUTE_RESOLVED' | 'CORRECTED',
    actor: string,
    details: Record<string, string>,
  ): Promise<boolean> {
    if (!(await repos.assertions.transitionStatus(assertion.id, from, to))) return false;
    await repos.assertions.appendEvent({ assertion_id: assertion.id, event_type: eventType, from_status: from, to_status: to, actor, details });
    return true;
  }

  private async tenantContext(repos: IntelligenceRepositories, principal: IngestPrincipal, tenant: TenantKey, id: string): Promise<TenantContext> {
    await requireEntitledTenant(repos, principal, tenant);
    const dispute = await repos.disputes.findById(id);
    if (dispute === null) throw refused('NOT_FOUND');
    const assertion = await repos.assertions.findById(dispute.assertion_id);
    if (assertion === null) throw refused('NOT_FOUND');
    const subject = await survivingSubject(repos, assertion.subject_id);
    if (subject.access_state !== 'ACTIVE') throw refused('NOT_FOUND');
    const refs = await tenantReferencesOn(repos, subject.id, tenant);
    if (refs.length === 0 || !assertionVisibleTo(assertion, tenant, crossTenantReadEnabled())) throw refused('NOT_FOUND');
    return { tenant, dispute, assertion, subjectId: subject.id, refs };
  }

  /** The assertion, only when it belongs to `subjectId` (merge-aware) — else a uniform 404. */
  private async ownedAssertion(repos: IntelligenceRepositories, assertionId: string, subjectId: string): Promise<Assertion> {
    const assertion = await repos.assertions.findById(assertionId);
    if (assertion === null || (await survivingSubject(repos, assertion.subject_id)).id !== subjectId) throw refused('NOT_FOUND');
    return assertion;
  }

  private async portalSubjects(repos: IntelligenceRepositories, rawReferences: unknown, principal: IngestPrincipal): Promise<Set<string>> {
    const parsed = parseReferenceParams(rawReferences);
    if (!parsed.ok) throw refused('INVALID_REQUEST', parsed.issues);
    if (parsed.value.some((t) => t.source_system_id !== principal.source_system_id)) throw refused('SOURCE_SYSTEM_MISMATCH');
    const subjects = new Set<string>();
    for (const tuple of parsed.value) {
      try {
        subjects.add((await requireActiveReference(repos, principal, tuple, { entitled: false })).subject.id);
      } catch {
        // An unknown / erased reference contributes nothing (uniform).
      }
    }
    return subjects;
  }

  private async portalDispute(
    repos: IntelligenceRepositories,
    id: string,
    subjects: Set<string>,
  ): Promise<{ dispute: AssertionDispute; assertion: Assertion }> {
    const dispute = await repos.disputes.findById(id);
    if (dispute === null) throw refused('NOT_FOUND');
    const assertion = await repos.assertions.findById(dispute.assertion_id);
    if (assertion === null || !subjects.has((await survivingSubject(repos, assertion.subject_id)).id)) throw refused('NOT_FOUND');
    return { dispute, assertion };
  }

  private async statement(repos: IntelligenceRepositories, disputeId: string, author: DisputeStatementAuthor, text: string): Promise<void> {
    await repos.disputes.appendStatement({
      dispute_id: disputeId,
      author,
      statement: text,
      statement_hash: hashStatement(text),
      channel: author === 'TALENT' ? 'portal' : 'tenant',
    });
  }

  private async event(
    repos: IntelligenceRepositories,
    dispute: AssertionDispute,
    type: DisputeEventType,
    e: { to?: string; actor: string; tenant?: TenantKey; details?: Record<string, string> },
  ): Promise<void> {
    await repos.disputes.appendEvent({
      dispute_id: dispute.id,
      event_type: type,
      from_status: type === 'OPENED' ? null : dispute.status,
      to_status: e.to ?? null,
      actor: e.actor,
      source_system_id: e.tenant?.source_system_id ?? null,
      source_tenant_id: e.tenant?.source_tenant_id ?? null,
      details: e.details ?? null,
    });
  }

  private portalSummary(d: AssertionDispute, a: Assertion): PortalDisputeSummary {
    return {
      dispute_id: d.id,
      assertion_id: a.id,
      assertion_type: a.assertion_type,
      status: d.status as DisputeStatus,
      opened_at: d.opened_at.toISOString(),
      updated_at: d.updated_at.toISOString(),
      resolution_note: d.resolution_note,
      sla: slaOf(d),
    };
  }

  private async portalView(repos: IntelligenceRepositories, d: AssertionDispute, a: Assertion): Promise<PortalDisputeView> {
    const fresh = (await repos.disputes.findById(d.id)) ?? d;
    return {
      ...this.portalSummary(fresh, a),
      statements: (await repos.disputes.listStatements(d.id)).map((s) => ({
        author: s.author as DisputeStatementAuthor,
        statement: s.statement,
        created_at: s.created_at.toISOString(),
      })),
    };
  }

  private contributor(a: Assertion, tenant: TenantKey): Contributor {
    if (isOwnAssertion(a, tenant)) return 'REQUESTING_TENANT';
    return isTiOriginated(a) ? 'TALENT_INTELLIGENCE' : 'OTHER_SOURCE';
  }

  private tenantSummary(d: AssertionDispute, a: Assertion, refs: ExternalTalentReference[], tenant: TenantKey): TenantDisputeSummary {
    return {
      dispute_id: d.id,
      external_talent_ids: refs.map((r) => r.external_talent_id).sort(),
      assertion_id: a.id,
      assertion_type: a.assertion_type,
      contributed_by: this.contributor(a, tenant),
      status: d.status as DisputeStatus,
      opened_at: d.opened_at.toISOString(),
      updated_at: d.updated_at.toISOString(),
      triage_due_at: d.triage_due_at.toISOString(),
      reinvestigation_due_at: d.reinvestigation_due_at.toISOString(),
    };
  }

  private async tenantView(repos: IntelligenceRepositories, ctx: TenantContext): Promise<TenantDisputeView> {
    const { dispute: d, assertion: a } = ctx;
    return {
      ...this.tenantSummary(d, a, ctx.refs, ctx.tenant),
      assertion_status: a.current_status,
      assertion_payload: (a.payload ?? {}) as Record<string, unknown>,
      resolution_note: d.resolution_note,
      no_transition_reason: d.no_transition_reason,
      sla: slaOf(d),
      statements: (await repos.disputes.listStatements(d.id)).map((s) => ({
        author: s.author as DisputeStatementAuthor,
        statement: s.statement,
        created_at: s.created_at.toISOString(),
      })),
    };
  }
}

function talentActor(reference: ExternalTalentReference): string {
  return `talent:reference:${reference.id}`;
}

/** `open` (OPEN + UNDER_REVIEW), `all`, or one DisputeStatus. */
function parseStatusFilter(raw: unknown, fallback: 'open' | 'all'): readonly string[] | null {
  const v = raw === undefined || raw === '' ? fallback : raw;
  if (v === 'all') return null;
  if (v === 'open') return OPEN;
  if (typeof v === 'string' && (DISPUTE_STATUSES as readonly string[]).includes(v)) return [v];
  throw refused('INVALID_REQUEST', ['status: open | all | a dispute status']);
}
