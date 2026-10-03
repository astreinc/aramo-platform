import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';
import type { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';

import { SubmittalWorkspaceService, type SubmittalWorkspaceContext } from '../submittal-workspace/submittal-workspace.service.js';
import type { EngagementGateService } from '../engagement/engagement-gate.service.js';
import type { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

// SW-4 — unit proofs for the Submittal Workspace composition. A mocked cross-schema
// Db ($queryRawUnsafe routed by table name) + mocked read-only domain services. Pins
// composition, the unified SW-3 readiness wiring, tenant/visibility concealment, and
// FIELD-LEVEL commercial authorization (compensation scope gates the whole section,
// incl. the frozen submitted_* snapshot whose names are outside the global mask).

const TENANT = '11111111-1111-7111-8111-111111111111';
const SUB = '99990000-0000-7000-8000-000000000001';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const COMPANY = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const PIPE = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

interface Rows {
  submittal?: Record<string, unknown>[];
  requisition?: Record<string, unknown>[];
  talent?: Record<string, unknown>[];
  company?: Record<string, unknown>[];
  pipeline?: Record<string, unknown>[];
  resume?: Record<string, unknown>[];
  policy?: Record<string, unknown>[];
  consumed?: Record<string, unknown>[];
  restriction?: Record<string, unknown>[];
  client_selection?: Record<string, unknown>[];
  interview?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
}

function makeDb(rows: Rows) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('"TalentSubmittalRecord"')) return rows.submittal ?? [];
      if (sql.includes('"Requisition"')) return rows.requisition ?? [];
      if (sql.includes('"TalentRecord"')) return rows.talent ?? [];
      if (sql.includes('"Company"')) return rows.company ?? [];
      if (sql.includes('"Pipeline"') && !sql.includes('TalentRequisitionResume')) return rows.pipeline ?? [];
      if (sql.includes('"TalentRequisitionResume"')) return rows.resume ?? [];
      if (sql.includes('"RequisitionSubmittalPolicy"')) return rows.policy ?? [];
      if (sql.includes('"SubmittalConsumption"')) return rows.consumed ?? [{ n: 0 }];
      if (sql.includes('"ClientTalentRestriction"')) return rows.restriction ?? [];
      if (sql.includes('"ClientSelectionProcess"')) return rows.client_selection ?? [];
      if (sql.includes('"InterviewSession"')) return rows.interview ?? [];
      if (sql.includes('"ClientSelectionEvent"')) return rows.events ?? [];
      return [];
    }),
  };
}

function readySubmittalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB, talent_id: TALENT, job_id: JOB, state: 'ready_for_review',
    created_by: 'u', created_at: new Date(), confirmed_at: null, revoked_at: null,
    pipeline_id: PIPE, resume_edition_id: null,
    submitted_at: null, submitted_by_actor_id: null, delivery_channel: null,
    submitted_bill_rate: null, submitted_rate_currency: null, submitted_rate_period: null,
    external_reference: null, external_submitted_at: null,
    ...overrides,
  };
}

const engagementMock = {
  resolveApplicability: vi.fn().mockResolvedValue('dormant'),
  readReadiness: vi.fn().mockResolvedValue({
    governed: false, policy_present: false, satisfied: true,
    enforcement_mode: null, override_available: false, results: [], missing: [], unavailable: false, capabilities: {},
  }),
} as unknown as EngagementGateService;
const docMock = { assess: vi.fn().mockResolvedValue({ satisfied: true, deny: null }) } as unknown as DocumentReadinessGate;
const cspMock = { resolveEffective: vi.fn().mockResolvedValue(null), decide: vi.fn() } as unknown as ClientSubmittalPolicyService;

function svc(db: ReturnType<typeof makeDb>) {
  return new SubmittalWorkspaceService(db, engagementMock, docMock, cspMock);
}

function ctx(overrides: Partial<SubmittalWorkspaceContext> = {}): SubmittalWorkspaceContext {
  return {
    tenant_id: TENANT,
    visible_requisition_ids: null,
    scopes: new Set<string>(['talent:read', 'compensation:view:bill']),
    submit_authority: true,
    request_id: 'req-1',
    ...overrides,
  };
}

// A fully-ready seed (all gates satisfiable) with an open requisition carrying a bill rate.
const READY_ROWS: Rows = {
  submittal: [readySubmittalRow()],
  requisition: [{ title: 'Scrum Master', status: 'open', company_id: COMPANY, recruiter_id: 'rec-1', owner_id: 'own-1', bill_rate_amount: '92.00', bill_rate_currency: 'USD', bill_rate_period: 'HOURLY' }],
  talent: [{ first_name: 'Divya', last_name: null, title: 'SM', city: 'Austin', state: 'TX', work_authorization: 'US_CITIZEN', owner_id: 'own-1' }],
  company: [{ name: 'Freddie Mac' }],
  pipeline: [{ id: PIPE, status: 'qualifying', requisition_id: JOB, talent_record_id: TALENT, tenant_id: TENANT }],
  resume: [{ resume_edition_id: 'r1' }],
  consumed: [{ n: 0 }],
};

describe('SubmittalWorkspaceService.compose', () => {
  beforeEach(() => vi.clearAllMocks());

  it('composes all sections; fully-ready seed → readiness READY + can_submit true', async () => {
    const r = await svc(makeDb(READY_ROWS)).compose(ctx(), SUB);
    expect(r.identity).toMatchObject({ submittal_id: SUB, talent: { id: TALENT, name: 'Divya' }, requisition: { id: JOB, title: 'Scrum Master' }, company: { id: COMPANY, name: 'Freddie Mac' } });
    expect(r.pipeline).toMatchObject({ linked_episode_id: PIPE, current_stage: 'qualifying', is_live: true });
    expect(r.submittal.state).toBe('ready_for_review');
    expect(r.readiness.status).toBe('READY');
    expect(r.documents).toMatchObject({ rtr_satisfied: true, resume_selected: true });
    expect(r.engagement.satisfied).toBe(true);
    expect(r.actions.can_submit_to_client).toBe(true);
    expect(r.actions.submit_authority).toBe(true);
    expect(r.actions.can_revoke).toBe(true); // ready_for_review is revocable
  });

  it('AUTHZ (D-6): READY but no submit authority → can_submit_to_client false (view-only), submit_authority false', async () => {
    // A view-only caller (e.g. a sourcer without submittal:approve): readiness is still
    // READY, but the server-owned CTA authority is false so the FE renders no Submit CTA.
    const r = await svc(makeDb(READY_ROWS)).compose(ctx({ submit_authority: false }), SUB);
    expect(r.readiness.status).toBe('READY');
    expect(r.actions.can_submit_to_client).toBe(false);
    expect(r.actions.submit_authority).toBe(false);
  });

  it('FIELD AUTHZ: commercial present with compensation:view:bill (live + frozen snapshot)', async () => {
    const rows: Rows = { ...READY_ROWS, submittal: [readySubmittalRow({ submitted_bill_rate: '90.00', submitted_rate_currency: 'USD', submitted_rate_period: 'HOURLY' })] };
    const r = await svc(makeDb(rows)).compose(ctx(), SUB);
    expect(r.commercial).toMatchObject({
      live_bill_rate_amount: '92.00', live_bill_rate_currency: 'USD',
      submitted_bill_rate: '90.00', submitted_rate_currency: 'USD',
    });
  });

  it('FIELD AUTHZ: commercial is NULL without compensation:view:bill (frozen snapshot NOT leaked)', async () => {
    const rows: Rows = { ...READY_ROWS, submittal: [readySubmittalRow({ submitted_bill_rate: '90.00' })] };
    const r = await svc(makeDb(rows)).compose(ctx({ scopes: new Set(['talent:read']) }), SUB);
    expect(r.commercial).toBeNull();
    // delivery section (non-financial) is still present.
    expect(r.delivery).toBeDefined();
  });

  it('TENANT: submittal absent for tenant → NOT_FOUND (404)', async () => {
    await expect(svc(makeDb({ submittal: [] })).compose(ctx(), SUB)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('VISIBILITY: requisition outside the visible set → concealed as NOT_FOUND', async () => {
    const r = svc(makeDb(READY_ROWS)).compose(ctx({ visible_requisition_ids: new Set(['some-other-req']) }), SUB);
    await expect(r).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('VISIBILITY: see-all (null) admits; visible set containing the job admits', async () => {
    const r1 = await svc(makeDb(READY_ROWS)).compose(ctx({ visible_requisition_ids: null }), SUB);
    expect(r1.identity.submittal_id).toBe(SUB);
    const r2 = await svc(makeDb(READY_ROWS)).compose(ctx({ visible_requisition_ids: new Set([JOB]) }), SUB);
    expect(r2.identity.submittal_id).toBe(SUB);
  });

  it('READINESS reflects a blocking gate: requisition not open → BLOCKED + can_submit false', async () => {
    const rows: Rows = { ...READY_ROWS, requisition: [{ ...READY_ROWS.requisition![0], status: 'on_hold' }] };
    const r = await svc(makeDb(rows)).compose(ctx(), SUB);
    expect(r.readiness.status).toBe('BLOCKED');
    expect(r.readiness.requirements.find((x) => x.key === 'requisition_open')!.satisfied).toBe(false);
    expect(r.actions.can_submit_to_client).toBe(false);
  });

  it('READINESS reflects pipeline-link: missing linked episode → pipeline_link blocking', async () => {
    const rows: Rows = { ...READY_ROWS, submittal: [readySubmittalRow({ pipeline_id: null })], pipeline: [] };
    const r = await svc(makeDb(rows)).compose(ctx(), SUB);
    expect(r.pipeline.linked_episode_id).toBeNull();
    expect(r.readiness.requirements.find((x) => x.key === 'pipeline_link')!.satisfied).toBe(false);
    expect(r.readiness.status).toBe('BLOCKED');
  });

  it('CLIENT SELECTION: composes state + process id/version/opened_at + latest interview (with id) + feedback from events (newest first)', async () => {
    const CS = '77770000-0000-7000-8000-000000000001';
    const IV = '88880000-0000-7000-8000-000000000001';
    const opened = new Date('2026-10-02T00:00:00.000Z');
    const rows: Rows = {
      ...READY_ROWS,
      client_selection: [{ id: CS, state: 'CLIENT_REVIEW', version: 3, created_at: opened }],
      interview: [{ id: IV, round: 2, state: 'SCHEDULED', scheduled_at: new Date() }],
      events: [
        { event_payload: { to_state: 'CLIENT_REVIEW', reason_code: 'UNDER_REVIEW', note: 'awaiting panel' }, created_at: new Date() },
      ],
    };
    const r = await svc(makeDb(rows)).compose(ctx(), SUB);
    expect(r.client_selection.present).toBe(true);
    expect(r.client_selection).toMatchObject({ process_id: CS, version: 3, state: 'CLIENT_REVIEW', opened_at: opened.toISOString() });
    expect(r.client_selection.latest_interview).toMatchObject({ id: IV, round: 2, state: 'SCHEDULED' });
    expect(r.client_selection.feedback[0]).toMatchObject({ reason_code: 'UNDER_REVIEW', note: 'awaiting panel' });
  });

  it('CLIENT SELECTION actions: server-owned (legal transition AND caller scope); CLIENT_REVIEW + scopes → move/select/decline/withdraw/schedule available', async () => {
    const rows: Rows = { ...READY_ROWS, client_selection: [{ id: 'cs', state: 'CLIENT_REVIEW', version: 0, created_at: new Date() }] };
    const scoped = ctx({ scopes: new Set(['talent:read', 'compensation:view:bill', 'client-selection:transition', 'client-selection:interview:schedule']) });
    const r = await svc(makeDb(rows)).compose(scoped, SUB);
    expect(r.client_selection.available_actions).toEqual({
      can_move_to_interview: true, can_mark_selected: true, can_decline: true, can_withdraw: true, can_schedule_interview: true,
    });
    // Without the client-selection scopes, every action is withheld (not cosmetically disabled).
    const unscoped = await svc(makeDb(rows)).compose(ctx(), SUB);
    expect(unscoped.client_selection.available_actions).toEqual({
      can_move_to_interview: false, can_mark_selected: false, can_decline: false, can_withdraw: false, can_schedule_interview: false,
    });
  });

  it('CLIENT SELECTION actions: terminal state (SELECTED) → no transition actions even with scopes', async () => {
    const rows: Rows = { ...READY_ROWS, client_selection: [{ id: 'cs', state: 'SELECTED', version: 1, created_at: new Date() }] };
    const scoped = ctx({ scopes: new Set(['talent:read', 'client-selection:transition', 'client-selection:interview:schedule']) });
    const r = await svc(makeDb(rows)).compose(scoped, SUB);
    expect(r.client_selection.available_actions).toEqual({
      can_move_to_interview: false, can_mark_selected: false, can_decline: false, can_withdraw: false, can_schedule_interview: false,
    });
  });

  it('absent optional domains are explicit (no client selection → present:false, empty feedback, all actions false)', async () => {
    const r = await svc(makeDb(READY_ROWS)).compose(ctx(), SUB);
    expect(r.client_selection).toMatchObject({ present: false, process_id: null, version: null, opened_at: null, state: null, latest_interview: null, feedback: [] });
    expect(r.client_selection.available_actions).toEqual({
      can_move_to_interview: false, can_mark_selected: false, can_decline: false, can_withdraw: false, can_schedule_interview: false,
    });
  });

  it('throws AramoError (not a raw throw) on NOT_FOUND', async () => {
    await expect(svc(makeDb({ submittal: [] })).compose(ctx(), SUB)).rejects.toBeInstanceOf(AramoError);
  });
});
