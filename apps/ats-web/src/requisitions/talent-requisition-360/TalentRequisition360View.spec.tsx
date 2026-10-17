import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentRequisition360View } from './TalentRequisition360View';

const REQ = {
  id: 'req-1', tenant_id: 't', site_id: null, title: 'Business Analyst – Multi-Family', requisition_number: 1001,
  company_id: 'co-1', contact_id: null, company_department_id: null, status: 'open', type: null, duration: null,
  description: null, notes: null, is_hot: true, openings: 1, openings_available: 1, capacity_balance: 1,
  client_submittal_status: null, client_submittal_reason: null, start_date: '2026-10-20', city: 'Washington',
  state: 'DC', postal_code: null, recruiter_id: null, owner_id: null, entered_by_id: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version: 1, compensation_model: 'CONTRACT',
  pay_rate_amount: null, pay_rate_currency: null, pay_rate_period: null, bill_rate_amount: null,
  bill_rate_currency: null, bill_rate_period: null, work_arrangement: 'hybrid', onsite_days_per_week: null,
};

const PIPELINES = {
  items: [
    { id: 'pp-1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1', requisition_id: 'req-1', status: 'qualifying', created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', version: 3 },
  ],
};

function card(talent: string, pipeline: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    talent_record_id: talent, pipeline_id: pipeline, column: 'contacted', owner: 'pipeline', source_object_id: pipeline,
    owner_state: 'qualifying',
    resume: { resume_edition_id: null, source: 'none', locked: false, label: null, display_date: null, tailored_for_requisition: false },
    rtr_state: null, rtr_status: 'CONFIRMED', email_evidence: true, voice_evidence: false, desired_pay: '$57/hr',
    readiness: null, days_in_stage: 1, stage_entered_at: null, assigned_recruiter_user_id: null, next_actions: [], handoff: false,
    ...extra,
  };
}

const BOARD = {
  requisition_id: 'req-1',
  total_active: 3,
  closed: { total: 0, by_reason: [] },
  columns: [
    { key: 'pipeline', owner: 'pipeline', count: 1, cards: [card('tal-0', 'pp-0')] },
    { key: 'contacted', owner: 'pipeline', count: 2, cards: [card('tal-1', 'pp-1'), card('tal-2', 'pp-2')] },
  ],
};

const T360 = {
  header: {
    talent_id: 'tal-1', display_name: 'Ravi Shankar', title: 'Business Analyst', work_authorization: 'H-1B',
    desired_compensation: null, availability: { status: 'Oct 20', detail: null },
  },
  attention: [
    { id: 'a1', kind: 'x', kicker: 'k', title: 'Technical screening not started', subtitle: 'Client requires it', requisition_id: 'req-1', requisition_label: 'REQ-1001', action: { kind: 'go', label: 'Open', href: '/somewhere' } },
    { id: 'a2', kind: 'x', kicker: 'k', title: 'Other requisition item', subtitle: null, requisition_id: 'req-9', requisition_label: 'REQ-9', action: null },
  ],
  tasks: [],
  recent_activity: {
    items: [
      { id: 'e1', occurred_at: '2026-10-11T16:12:00Z', category: 'document', title: 'Right to Represent signed', body: null, requisition_id: 'req-1', requisition_label: 'REQ-1001', actor_label: 'Ravi Shankar', channel: null },
      { id: 'e2', occurred_at: '2026-10-08T09:15:00Z', category: 'response', title: 'Talent responded · phone', body: null, requisition_id: 'req-1', requisition_label: 'REQ-1001', actor_label: 'Purush P.', channel: 'Recruiter-attested' },
      { id: 'e3', occurred_at: '2026-10-05T09:15:00Z', category: 'email', title: 'Elsewhere', body: null, requisition_id: 'req-9', requisition_label: 'REQ-9', actor_label: 'Purush P.', channel: null },
    ],
    category_counts: {},
    has_more: false,
  },
  documents: { key_documents: [], total: 0 },
  identity: null,
  profile: { summary: null, facts: [], skills: [], work_history: [] },
  opportunities: { active: [{}, {}, {}], closed: [] },
};

function journey(actions: readonly string[]): Record<string, unknown> {
  return {
    requisition_id: 'req-1', talent_record_id: 'tal-1', current_journey_stage: 'QUALIFYING',
    stages: [{ stage: 'QUALIFYING', owner: 'pipeline', source_object_id: 'pp-1', occurred_at: '2026-10-09T10:40:00Z' }],
    sub_states: {}, offer_start_exceptions: [], actions: [], recruiting_available_actions: actions,
    offer_document: null, pre_start: null, placement: null,
  };
}

const PROFILE = {
  requisition_id: 'req-1', golden_profile_id: 'g', has_profile: true, jd_text: '', role_family: null, seniority_level: null,
  generated_by: 'manual', required_skills: [{ name: 'SQL' }], preferred_skills: [{ name: 'Power BI' }],
  critical_skills: [{ name: 'Requirements elicitation' }], experience: { industries: [] }, constraints: {},
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function mockApi(opts: { actions?: readonly string[]; board?: unknown } = {}): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body != null ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, method, body });
    const json = (b: unknown): Response =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v1/rtr/current')) return json({ current: { document_id: 'doc-rtr-1', status: 'AWAITING_SIGNATURE', document_status: 'SENT' } });
    if (url.includes('/v1/rtr/doc-rtr-1/remind')) return json({ document_id: 'doc-rtr-1', status: 'AWAITING_SIGNATURE', reminder_sent: true });
    if (url.includes('/transition')) return json({ ...PIPELINES.items[0], status: 'qualified', version: 4 });
    if (url.includes('/v1/talent-records/tal-1') && method === 'PATCH') return json({ id: 'tal-1', first_name: 'Ravi', last_name: 'Shankar', ...(body as object) });
    if (url.includes('/journey')) return json(journey(opts.actions ?? ['mark_qualified']));
    if (url.includes('/talent-board')) return json(opts.board ?? BOARD);
    if (url.includes('/profile')) return json(PROFILE);
    if (url.includes('/v1/requisitions/req-1')) return json(REQ);
    if (url.includes('/v1/pipelines')) return json(PIPELINES);
    if (url.includes('/v1/talent-360/')) return json(T360);
    if (url.includes('/v1/talent-records/tal-1'))
      return json({ id: 'tal-1', first_name: 'Ravi', last_name: 'Shankar', title: 'Business Analyst', current_employer: 'Cognizant', is_hot: false, email1: null });
    if (url.includes('/v1/companies/co-1')) return json({ id: 'co-1', name: 'Mindlance' });
    if (url.includes('voice-evidence')) return json({ talent_id: 'tal-1', requisition_id: 'req-1', attempted: true, two_way_conversation: false, evidence_strength: null, latest_interaction_id: null, latest_outcome: null, latest_at: null });
    return json({ items: [] });
  });
  return calls;
}

function session(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes: [...scopes], iat: 0, exp: 0 } as Session;
}

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(scopes: readonly string[], path = '/requisitions/req-1/talent/tal-1'): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/requisitions/:reqId/talent/:talentId"
            element={
              <>
                <TalentRequisition360View sessionOverride={session(scopes)} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/requisitions/:reqId" element={<div data-testid="req-route" />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const BASE = ['requisition:read', 'talent:read', 'pipeline:read'];

describe('TalentRequisition360View', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.classList.remove('tr360-route');
  });

  it('renders the page shell: breadcrumb, title (REQ), meta, stepper, tabs and section nav — no drawer', async () => {
    mockApi();
    mount(BASE);
    expect(await screen.findByRole('heading', { name: /Business Analyst – Multi-Family/ })).toHaveTextContent('(REQ-1001)');
    expect(screen.getByRole('link', { name: 'Requisitions' })).toHaveAttribute('href', '/requisitions');
    expect(await screen.findByRole('link', { name: 'Mindlance' })).toBeInTheDocument();
    expect(screen.getByText('Washington, DC · Hybrid')).toBeInTheDocument();
    expect(screen.getByText('Start Oct 20, 2026')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    // Stepper: the server-owned stage → "Qualifying" is current.
    const current = await screen.findByRole('button', { name: /Qualifying/, current: 'step' });
    expect(current).toBeInTheDocument();
    // Tabs, exact order.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview', 'Conversation Intelligence', 'Technical Screening', 'Submittal', 'Tasks', 'Notes',
    ]);
    // Section nav, exact order.
    const nav = screen.getByRole('navigation', { name: 'Talent sections' });
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual([
      'Back to REQ-1001 pipeline', 'Collapse talent sections', 'Overview', 'Experience', 'Skills', 'Work authorization',
      'Opportunities', 'Activity', 'Documents', 'Communication', 'Talent Trust', 'Conversation Intelligence',
      'Technical Screening', 'Notes',
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Route chrome: icon-only app nav while mounted.
    expect(document.body.classList.contains('tr360-route')).toBe(true);
  });

  it('Overview: attention, activity and tasks are scoped to THIS requisition; skills split must-have / other', async () => {
    mockApi();
    mount(BASE);
    expect(await screen.findByText('Technical screening not started')).toBeInTheDocument();
    expect(screen.queryByText('Other requisition item')).toBeNull();
    expect(screen.getByText(/Same facts as My Desk, scoped to Ravi on REQ-1001/)).toBeInTheDocument();
    const activity = screen.getByTestId('tr360-activity');
    expect(within(activity).getByText('Right to Represent signed')).toBeInTheDocument();
    expect(within(activity).queryByText('Elsewhere')).toBeNull();
    const skills = screen.getByTestId('tr360-skills');
    expect(within(skills).getByText('Requirements elicitation')).toHaveClass('tr360-skill--must');
    expect(within(skills).getByText('SQL')).toHaveClass('tr360-skill--must');
    expect(within(skills).getByText('Power BI')).not.toHaveClass('tr360-skill--must');
    // RTR from the board's signing status.
    expect(within(screen.getByTestId('tr360-qualifying')).getByText('Signed')).toBeInTheDocument();
  });

  it('the primary action is the server-offered one: "Mark qualified" runs the governed CAS transition', async () => {
    const calls = mockApi({ actions: ['mark_qualified'] });
    mount([...BASE, 'pipeline:change-status']);
    const primary = await screen.findByTestId('tr360-primary');
    await waitFor(() => expect(primary).toHaveTextContent('Mark qualified'));
    expect(primary).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(primary);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/v1/pipelines/pp-1/transition'))).toBe(true));
    const t = calls.find((c) => c.url.includes('/transition'));
    expect(t?.method).toBe('POST');
    expect(t?.body).toEqual({ to_status: 'qualified', expected_version: 3 });
  });

  it('when the server offers no action the primary is disabled with its reason, and never writes', async () => {
    const calls = mockApi({ actions: [] });
    mount([...BASE, 'pipeline:change-status']);
    const primary = await screen.findByTestId('tr360-primary');
    await waitFor(() => expect(primary).toHaveAttribute('aria-disabled', 'true'));
    expect(primary).toHaveAccessibleDescription(/not offered this step/);
    fireEvent.click(primary);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('without pipeline:change-status the offered action is disabled (permission reason)', async () => {
    mockApi({ actions: ['mark_qualified'] });
    mount(BASE);
    const primary = await screen.findByTestId('tr360-primary');
    await waitFor(() => expect(primary).toHaveAttribute('aria-disabled', 'true'));
    expect(primary).toHaveAccessibleDescription(/can't change this Talent's stage/);
  });

  it('prev / next move within the same requisition pipeline (board order) and keep the active tab', async () => {
    mockApi();
    mount(BASE, '/requisitions/req-1/talent/tal-1?view=notes');
    expect(await screen.findByText('2 of 3 in pipeline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next talent in this pipeline' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/requisitions/req-1/talent/tal-2?view=notes'));
    fireEvent.click(screen.getByRole('button', { name: 'Previous talent in this pipeline' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/requisitions/req-1/talent/tal-1?view=notes'));
  });

  it('section nav and tabs stay in sync; a stage step opens its summary without changing stage', async () => {
    const calls = mockApi();
    mount(BASE);
    await screen.findByTestId('tr360-qualifying');
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Notes', current: 'page' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Offer/ }));
    expect(await screen.findByText(/Offer & start lives in its own journey/)).toBeInTheDocument();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('the section nav collapses to icons (aria-expanded) and the back link becomes the first item', async () => {
    mockApi();
    mount(BASE);
    const toggle = await screen.findByRole('button', { name: 'Collapse talent sections' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    const expand = screen.getByRole('button', { name: 'Expand talent sections' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Back to REQ-1001 pipeline' })).toBeInTheDocument();
    expect(screen.queryByText('Back to REQ-1001 pipeline')).toBeNull(); // icon only
  });

  it('RTR awaiting signature: "Send reminder" re-notifies the current envelope (document:execute)', async () => {
    const awaiting = {
      ...BOARD,
      columns: [{ key: 'contacted', owner: 'pipeline', count: 1, cards: [card('tal-1', 'pp-1', { rtr_status: 'SENT' })] }],
    };
    const calls = mockApi({ board: awaiting });
    mount([...BASE, 'document:read', 'document:execute']);
    expect(await screen.findAllByText('Awaiting signature')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Send reminder' }));
    expect(await screen.findByText('Reminder sent')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/v1/rtr/doc-rtr-1/remind'))).toBe(true);
  });

  it('RTR awaiting signature without document:execute: no reminder, only View', async () => {
    const awaiting = {
      ...BOARD,
      columns: [{ key: 'contacted', owner: 'pipeline', count: 1, cards: [card('tal-1', 'pp-1', { rtr_status: 'SENT' })] }],
    };
    mockApi({ board: awaiting });
    mount([...BASE, 'document:read']);
    expect(await screen.findAllByText('Awaiting signature')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Send reminder' })).not.toBeInTheDocument();
  });

  it('Technical Screening (flag off): only the empty state; no CTA, no screening calls — even with screening scopes', async () => {
    const calls = mockApi();
    mount([...BASE, 'screening:read', 'screening:create', 'screening:edit', 'screening:confirm']);
    await screen.findByTestId('tr360-qualifying');
    fireEvent.click(screen.getByRole('tab', { name: 'Technical Screening' }));
    expect(screen.getByText('No technical screening yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare screening' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New screening' })).toBeNull();
    expect(calls.some((c) => /screening|transcript|llm/i.test(c.url))).toBe(false);
  });

  it('⋯ menu: HOT triage PATCHes is_hot (talent:edit) and Edit talent details links to the edit page', async () => {
    const calls = mockApi();
    mount([...BASE, 'talent:edit']);
    await screen.findByTestId('tr360-qualifying');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Edit talent details' })).toHaveAttribute('href', '/talent/tal-1/edit');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as HOT' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.url.includes('/v1/talent-records/tal-1'))?.body).toEqual({ is_hot: true }),
    );
  });

  it('⋯ menu offers "Remove from requisition" only when the server projects pipeline.void', async () => {
    const voidable = {
      ...BOARD,
      columns: [
        {
          key: 'pipeline', owner: 'pipeline', count: 1,
          cards: [card('tal-1', 'pp-1', { next_actions: [{ key: 'pipeline.void', label: 'Remove from requisition', owner: 'pipeline', command_route: 'POST /v1/pipelines/pp-1/void', required_scope: 'pipeline:change-status' }] })],
        },
      ],
    };
    mockApi({ board: voidable });
    mount([...BASE, 'pipeline:change-status']);
    await screen.findByText('1 of 1 in pipeline');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Remove from requisition' })).toBeInTheDocument();
  });
});
