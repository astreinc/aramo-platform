import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Talent360View } from './Talent360View';
import { getTalent360 } from './talent-360-api';
import type {
  Talent360View as Talent360ViewModel,
  TalentRequisitionJourney,
} from './talent-360-types';

// Render/interaction tests for the Talent 360 workspace. The composed read is
// mocked (getTalent360); the reused heavy surfaces (TrustPanel, WorkHistory,
// CallButton, AddToRequisitionDialog, the email composer) are stubbed so this
// spec exercises Talent360View's OWN presentation + interaction behavior — it
// renders the contract and never re-derives server truth.

vi.mock('./talent-360-api');
vi.mock('../shell/breadcrumb', () => ({ useEntityCrumb: () => undefined }));
// Trust & Evidence reads the SAME authoritative dossier via a recruiter-facing
// adapter; stub getDossier so the spec exercises the adapter's projection.
vi.mock('../talent/dossier-api', () => ({
  getDossier: vi.fn().mockResolvedValue({
    ledger_established: false,
    dimensions: {},
    verifications: [],
    merge_provenance: [],
    statements: [],
    contradictions: [],
    proposal_pointers: [],
  }),
}));
vi.mock('../communications/CallButton', () => ({
  CallButton: () => <button type="button">Call</button>,
}));
vi.mock('../talent/AddToRequisitionDialog', () => ({
  AddToRequisitionDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-dialog">add</div> : null,
}));
vi.mock('../microsoft/RequisitionContactEmailComposer', () => ({
  RequisitionContactEmailComposer: ({ open, requisitionId }: { open: boolean; requisitionId: string }) =>
    open ? <div data-testid="email-composer">{requisitionId}</div> : null,
}));
vi.mock('../microsoft/GeneralTalentContactEmailComposer', () => ({
  GeneralTalentContactEmailComposer: ({ open, talentId }: { open: boolean; talentId: string }) =>
    open ? <div data-testid="general-email-composer">{talentId}</div> : null,
}));
// PO RULING "Consent Capture" — the Contactability "Record consent" action opens
// the reusable capture dialog; stub it so this spec exercises Talent360View's
// action-first/status-first behavior, not the dialog internals.
vi.mock('../consent/RecordConsentDialog', () => ({
  RecordConsentDialog: ({ open, talentRecordId }: { open: boolean; talentRecordId: string }) =>
    open ? <div data-testid="record-consent-dialog">{talentRecordId}</div> : null,
}));
const act = vi.hoisted(() => ({ createNote: vi.fn(), listActivities: vi.fn() }));
vi.mock('../activity/activity-api', () => ({ createNote: act.createNote, listActivities: act.listActivities }));
const adv = vi.hoisted(() => ({ dismissAdvisory: vi.fn() }));
vi.mock('../sourcing/sourcing-api', () => ({ dismissAdvisory: adv.dismissAdvisory }));
vi.mock('../microsoft/ScheduleMeetingDialog', () => ({
  ScheduleMeetingDialog: ({ open, requisitionId }: { open: boolean; requisitionId: string }) =>
    open ? <div data-testid="schedule-dialog">{requisitionId}</div> : null,
}));
const tal = vi.hoisted(() => ({ getTalent: vi.fn(), getTalentWorkHistory: vi.fn(), updateTalent: vi.fn(), getTalentWorkAuthorizationState: vi.fn(), getTalentProfileHydration: vi.fn() }));
vi.mock('../talent/talent-api', () => ({
  getTalent: tal.getTalent,
  getTalentWorkHistory: tal.getTalentWorkHistory,
  updateTalent: tal.updateTalent,
  getTalentWorkAuthorizationState: tal.getTalentWorkAuthorizationState,
  getTalentProfileHydration: tal.getTalentProfileHydration,
}));
// D3 — Documents reuses Edit talent's resume panel; stub it here.
vi.mock('../talent/TalentEditView', () => ({
  EditResumePanel: ({ talentId, disabled }: { talentId: string; disabled: boolean }) => (
    <div data-testid="resume-panel">{`${talentId}:${disabled ? 'ro' : 'rw'}`}</div>
  ),
}));
vi.mock('../consent/ConsentHistoryPanel', () => ({
  ConsentHistoryPanel: ({ talentId }: { talentId: string }) => <div data-testid="consent-history">{talentId}</div>,
}));

// CRM-5 — mutable scopes (per-test authority) + spies for the new task / lists
// deps the page now reaches (createTask/updateTask, reverse-membership read).
const BASE_SCOPES = [
  'talent:read', 'pipeline:read', 'task:read', 'activity:read',
  'communication:read', 'document:read', 'identity:resolve',
];
const h = vi.hoisted(() => ({
  scopes: [] as string[],
  createTask: vi.fn(),
  updateTask: vi.fn(),
  listTalentMemberships: vi.fn(),
}));
vi.mock('../task/task-api', () => ({ createTask: h.createTask, updateTask: h.updateTask }));
vi.mock('../talent/saved-list-api', async (importActual) => {
  const actual = await importActual<typeof import('../talent/saved-list-api')>();
  return { ...actual, listTalentMemberships: h.listTalentMemberships };
});
// CRM-6 — the follow-up modal's assignee picker roster (self u1 + a teammate).
vi.mock('../users/users-api', () => ({
  fetchAssignableUsers: vi.fn().mockResolvedValue([
    { user_id: 'u1', display_name: 'Me Myself' },
    { user_id: 'u2', display_name: 'Sanjay Kumar' },
  ]),
}));
vi.mock('@aramo/fe-foundation', async (importActual) => {
  const actual = await importActual<typeof import('@aramo/fe-foundation')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'authenticated' as const,
      session: {
        sub: 'u1',
        consumer_type: 'recruiter' as const,
        tenant_id: 't1',
        scopes: h.scopes,
        iat: 0,
        exp: 9_999_999_999,
      },
    }),
    hasScope: (s: { scopes?: string[] } | null, scope: string) => s?.scopes?.includes(scope) ?? false,
  };
});

const getTalent360Mock = vi.mocked(getTalent360);

const journey = (
  reqId: string,
  sub: Partial<TalentRequisitionJourney['sub_states']>,
): TalentRequisitionJourney => ({
  requisition_id: reqId,
  talent_record_id: 'tal-1',
  current_journey_stage: sub.pipeline_stage ?? 'QUALIFIED',
  stages: [],
  sub_states: {
    pipeline_stage: 'qualified',
    submittal_state: null,
    selection_state: null,
    interview_state: null,
    offer_state: null,
    placement_state: null,
    pre_start_state: null,
    assignment_state: null,
    ...sub,
  },
  actions: [],
});

function makeModel(overrides: Partial<Talent360ViewModel> = {}): Talent360ViewModel {
  return {
    generated_at: '2026-09-30T13:14:00.000Z',
    server_date: '2026-09-30',
    header: {
      talent_id: 'tal-1',
      first_name: 'Divya',
      last_name: 'Vasudevan',
      display_name: 'Divya Vasudevan',
      title: 'Scrum Master / Product Owner',
      location: 'Vienna, VA',
      experience_summary: '11 yrs experience',
      email: 'divya@example.com',
      phone: '(703) 555-0182',
      work_authorization: 'permanent_resident',
      desired_compensation: '$85/hr',
      engagement_type: 'c2c',
      availability: { status: 'available_now', detail: null },
      recruiting_ready: { ready: true, rule: 'A live record with at least one contact channel and a work authorization on record.' },
      contactability: { summary: 'contactable', recruiting_permitted: true, email_permitted: true, phone_permitted: true, sms_permitted: false },
      actions: { can_email: true, can_call: true, can_add_to_requisition: true, can_log_activity: true, can_edit_profile: true },
      record_status: 'live',
      superseded_by_record_id: null,
    },
    relationship_strip: {
      active_opportunities: 2,
      submittals: 1,
      interviews_today: 1,
      offers: 0,
      assignments: 0,
      last_contact: { at: '2026-09-30T13:14:00.000Z', channel: 'email' },
    },
    opportunities: {
      active: [
        { pipeline_id: 'p1', requisition_id: 'r1', requisition_code: 'REQ-1001', client_name: 'Freddie Mac', role_title: 'Scrum Master', stage: 'INTERVIEW', contextual_state: 'Client interview today', age_label: '2d', owner_label: 'You', next_action: { kind: 'open_interview', label: 'Open interview', href: '/requisitions/r1' }, open_journey_href: '/requisitions/r1', journey: journey('r1', { pipeline_stage: 'INTERVIEW', interview_state: 'SCHEDULED' }) },
        { pipeline_id: 'p2', requisition_id: 'r2', requisition_code: 'REQ-1032', client_name: 'Fannie Mae', role_title: 'Agile Delivery Lead', stage: 'CLIENT_REVIEW', contextual_state: 'Waiting for client · 3 days', age_label: '3d', owner_label: 'Sanjay Kumar', next_action: { kind: 'follow_up', label: 'Follow up', href: '/requisitions/r2' }, open_journey_href: '/requisitions/r2', journey: journey('r2', { pipeline_stage: 'CLIENT_REVIEW', selection_state: 'CLIENT_REVIEW' }) },
      ],
      closed: [],
    },
    attention: [
      { id: 'a1', kind: 'interview', kicker: 'TODAY', title: 'Freddie Mac client interview', subtitle: 'REQ-1001', requisition_id: 'r1', requisition_label: 'REQ-1001', action: { kind: 'open', label: 'Open', href: '/requisitions/r1' } },
    ],
    tasks: [
      { id: 't1', title: 'Debrief call with Divya', status: 'open', due_date: '2026-10-01T00:00:00Z', requisition_id: 'r1', requisition_label: 'REQ-1001' },
    ],
    recent_activity: {
      items: [
        { id: 'e1', occurred_at: '2026-09-30T13:14:00Z', category: 'communications', title: 'Email received', body: 'Happy to proceed.', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'From Divya', channel: 'email' },
      ],
      category_counts: { communications: 1 },
      has_more: false,
    },
    documents: {
      key_documents: [
        { id: 'd1', kind: 'Right to Represent · Freddie Mac', requisition_id: 'r1', requisition_label: 'REQ-1001', meta: 'Signed', signed: true, signed_at: '2026-09-26T00:00:00Z' },
      ],
      total: 3,
    },
    identity: { primary_email_confirmed: true, mobile_confirmed: true, advisory: { advisory_id: 'adv1', label: 'Possible duplicate needs review' } },
    profile: {
      summary: '11 years in Agile delivery.',
      facts: [{ label: 'availability', value: 'available_now', source: null }],
      skills: [{ label: 'Scrum', verified: true }],
      work_history: [],
    },
    relationship: {
      history: { known_since: '2024-03-01T00:00:00Z', requisitions: 5, submittals: 3, interviews: 2, placements: 0 },
      ownership: { owner_provenance: { user_id: 'u1', name: 'Purush P.' }, also_working_with: [], worked_with_before: [], source: 'Referral sourcing', source_channel: null },
    },
    authorized_sections: { opportunities: true, attention: true, tasks: true, activity: true, communications: true, documents: true, identity: true },
    ...overrides,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderView(path = '/talent/tal-1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/talent/:talentId"
          element={
            <>
              <Talent360View />
              <LocationProbe />
            </>
          }
        />
        <Route path="/requisitions/:reqId/talent/:talentId" element={<LocationProbe />} />
        <Route path="/talent" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const RECORD = {
  id: 'tal-1', first_name: 'Divya', last_name: 'Vasudevan', title: 'Scrum Master / Product Owner',
  email1: 'divya@example.com', email2: null, phone_cell: '571-307-0783', phone_home: null, phone_work: '703-555-0100',
  best_time_to_call: null, web_site: 'divya.example.com/portfolio', address: '2909 Gettysburg Sq', address2: null,
  city: 'Vienna', state: 'VA', zip: '22181', country: 'US', can_relocate: false,
  current_employer: 'Freddie Mac', work_authorization: 'permanent_resident', availability_status: 'available_now',
  date_available: null, engagement_type: 'contract', desired_pay: '70/hr', current_pay: '$65/hr', is_hot: false,
  source: 'Referral', notes: 'Prefers hybrid.\nOpen to W2.', key_skills: 'Scrum, SAFe',
};
const WORK_HISTORY = [
  { id: 'w1', employer_name: 'Freddie Mac', role_title: 'Senior System Analyst', start_date: '2008-10-01', end_date: '2011-04-01', employment_type: null, description: null, source: 'resume', verified: false },
  { id: 'w2', employer_name: 'Freddie Mac', role_title: 'Scrum Coach', start_date: '2025-01-01', end_date: null, employment_type: null, description: null, source: 'resume', verified: false },
];

beforeEach(() => {
  h.scopes = [...BASE_SCOPES];
  h.createTask.mockResolvedValue({});
  h.updateTask.mockResolvedValue({});
  h.listTalentMemberships.mockResolvedValue([]);
  act.createNote.mockResolvedValue({});
  act.listActivities.mockResolvedValue({ items: [] });
  adv.dismissAdvisory.mockResolvedValue({});
  tal.getTalent.mockResolvedValue(RECORD);
  tal.getTalentWorkHistory.mockResolvedValue({ work_history: WORK_HISTORY });
  tal.getTalentProfileHydration.mockResolvedValue({
    talent_record_id: 'tal-1',
    fields: [
      { field_key: 'title', current_value: 'Scrum Master / Product Owner', value_state: 'SET', source_type: 'RESUME', projection_policy: 'AUTO', provenance: null, resolution_status: 'NONE', resolution_reason: null, proposed_value: null },
      { field_key: 'desired_pay', current_value: '70/hr', value_state: 'SET', source_type: 'MANUAL', projection_policy: 'HOLD', provenance: null, resolution_status: 'NONE', resolution_reason: null, proposed_value: null },
    ],
  });
  tal.getTalentWorkAuthorizationState.mockResolvedValue({
    talent_id: 'tal-1',
    current: { work_authorization_status: 'permanent_resident', authorized_to_work_in: ['US'], visa_type: null, requires_sponsorship: false, asserted_at: '2026-09-23T12:00:00Z', effective_from: null, effective_to: null, expires_at: null },
    history: [],
  });
  tal.updateTalent.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({ ...RECORD, ...body }));
  localStorage.clear();
});
afterEach(() => vi.clearAllMocks());


const nav = () => screen.getByRole('navigation', { name: 'Talent sections' });


describe('Talent360View — redesign shell (§3–§4)', () => {
  it('renders the shared section nav: 3 groups, 12 sections in order, with badges from the payload', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByRole('heading', { name: 'Divya Vasudevan', level: 1 });
    expect(within(nav()).getByText('PERSON')).toBeInTheDocument();
    expect(within(nav()).getByText('WORK')).toBeInTheDocument();
    expect(within(nav()).getByText('EVIDENCE')).toBeInTheDocument();
    const items = within(nav())
      .getAllByRole('button')
      .map((b) => b.getAttribute('title'))
      .filter((t) => t !== null && !/talent sections|Back to Talent/.test(t));
    expect(items).toEqual([
      'Overview', 'Profile', 'Work authorization', 'Documents', 'Opportunities', 'Activity', 'Tasks', 'Lists', 'Notes',
      'Talent Trust', 'Conversation Intelligence', 'Technical Screening',
    ]);
    expect(within(nav()).getByRole('button', { name: /Opportunities/ })).toHaveTextContent('Opportunities2');
    expect(within(nav()).getByRole('button', { name: /Documents/ })).toHaveTextContent('Documents3');
    expect(within(nav()).getByRole('button', { name: /Talent Trust/ })).toHaveTextContent('Talent Trust!');
    expect(within(nav()).getByRole('button', { name: /Overview/ })).toHaveAttribute('aria-current', 'page');
  });

  it('removes the old layout: no tab strip, KPI strip, collapsible chevrons or drawers', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByRole('heading', { name: 'Divya Vasudevan', level: 1 });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('ACTIVE OPPORTUNITIES')).toBeNull();
    expect(screen.queryByRole('button', { name: /Toggle/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sticky person header: breadcrumb with section, chips from projections, contact lines', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByRole('heading', { name: 'Divya Vasudevan', level: 1 });
    const hd = screen.getByRole('banner');
    expect(within(hd).getByRole('link', { name: 'Talent' })).toHaveAttribute('href', '/talent');
    expect(within(hd).getByText('Overview')).toBeInTheDocument();
    expect(within(hd).getByText('Available now')).toBeInTheDocument();
    expect(within(hd).getByText('Recruiting ready')).toHaveAttribute('title', expect.stringMatching(/Worked out by Aramo/));
    expect(within(hd).getByRole('button', { name: 'Contact permitted · no SMS' })).toBeInTheDocument();
    expect(within(hd).getByRole('button', { name: 'Identity · 1 to review' })).toBeInTheDocument();
    expect(within(hd).getByText('divya@example.com')).toBeInTheDocument();
    expect(within(hd).getByText('Known since Mar 2024 · 5 requisitions')).toBeInTheDocument();
  });

  it('section is a URL param (?section=) that survives reload; selecting one replaces it', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=trust');
    expect(await screen.findByTestId('t360-trust')).toBeInTheDocument();
    fireEvent.click(within(nav()).getByRole('button', { name: /Activity/ }));
    await waitFor(() => expect(screen.getAllByTestId('loc')[0]).toHaveTextContent('/talent/tal-1?section=activity'));
    expect(screen.getByTestId('t360-activity')).toBeInTheDocument();
    fireEvent.click(within(nav()).getByRole('button', { name: /Overview/ }));
    await waitFor(() => expect(screen.getAllByTestId('loc')[0]).toHaveTextContent(/^\/talent\/tal-1$/));
  });

  it('identity chip and contact chip open Talent Trust', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Identity · 1 to review' }));
    expect(await screen.findByTestId('t360-trust')).toBeInTheDocument();
  });

  it('section nav collapse persists under talent360.secOpen', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    const toggle = await screen.findByRole('button', { name: 'Collapse talent sections' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('talent360.secOpen')).toBe('0');
    expect(screen.getByRole('button', { name: 'Expand talent sections' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Talent360View — Overview (§6)', () => {
  it('active opportunity rows are whole-row links to Talent × Requisition 360', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    const card = await screen.findByTestId('t360-active-opps');
    const row = within(card).getByRole('link', { name: /REQ-1001/ });
    expect(row).toHaveAttribute('href', '/requisitions/r1/talent/tal-1');
    expect(within(row).getByText('Interview')).toBeInTheDocument();
    expect(within(row).getByText('Client interview today')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /REQ-1032/ })).toHaveAttribute('href', '/requisitions/r2/talent/tal-1');
  });

  it('Your attention renders the projection; Open navigates to that requisition’s Talent × Requisition 360', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    const attn = await screen.findByTestId('t360-attention');
    expect(within(attn).getByText(/Same facts as My Desk, scoped to Divya/)).toBeInTheDocument();
    fireEvent.click(within(attn).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/requisitions/r1/talent/tal-1'));
  });

  it('shows the calm empty state when nothing needs attention', async () => {
    getTalent360Mock.mockResolvedValue(makeModel({ attention: [] }));
    renderView();
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeInTheDocument();
  });

  it('Tasks checkbox completes via updateTask (task:write); read-only actors see a dot', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Complete: Debrief call with Divya' }));
    await waitFor(() => expect(h.updateTask).toHaveBeenCalledWith('t1', { status: 'done' }));
  });

  it('Tasks checkbox is hidden without task:write', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Debrief call with Divya');
    expect(screen.queryByRole('button', { name: /Complete:/ })).toBeNull();
  });

  it('Relationship summary comes from the composed history', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    expect(await screen.findByText('5 requisitions')).toBeInTheDocument();
    expect(screen.getByText(/Purush P\. · Referral sourcing/)).toBeInTheDocument();
  });
});

describe('Talent360View — header actions (§4, §10)', () => {
  it('Email opens the requisition composer when there is one active opportunity', async () => {
    const m = makeModel();
    getTalent360Mock.mockResolvedValue(makeModel({ opportunities: { active: (m.opportunities?.active ?? []).slice(0, 1), closed: [] } }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Email' }));
    expect(await screen.findByTestId('email-composer')).toHaveTextContent('r1');
  });

  it('Email opens the general composer with no active opportunity', async () => {
    getTalent360Mock.mockResolvedValue(makeModel({ opportunities: { active: [], closed: [] } }));
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Email' }));
    expect(await screen.findByTestId('general-email-composer')).toHaveTextContent('tal-1');
  });

  it('Schedule (meeting:create) asks for the requisition when several are active, then opens the dialog', async () => {
    h.scopes = [...BASE_SCOPES, 'communication:meeting:create'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule' }));
    fireEvent.click(await screen.findByRole('button', { name: /REQ-1032/ }));
    expect(await screen.findByTestId('schedule-dialog')).toHaveTextContent('r2');
  });

  it('actions are hidden (not disabled) under contact restriction', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        header: {
          ...makeModel().header,
          contactability: { summary: 'do_not_contact', recruiting_permitted: false, email_permitted: false, phone_permitted: false, sms_permitted: false },
        },
      }),
    );
    renderView();
    await screen.findByRole('heading', { name: 'Divya Vasudevan', level: 1 });
    expect(screen.queryByRole('button', { name: 'Email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Call' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Contact restricted' })).toBeInTheDocument();
  });

  it('Add to requisition opens the existing picker; ··· holds Add to list · Edit profile · Log activity', async () => {
    h.scopes = [...BASE_SCOPES, 'saved-list:edit'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Add to requisition' }));
    expect(screen.getByTestId('add-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Add to list', 'Edit profile', 'Log activity']);
    expect(screen.getByRole('menuitem', { name: 'Edit profile' })).toHaveAttribute('href', '/talent/tal-1/edit');
  });
});

describe('Talent360View — sections (§7–§9)', () => {
  it('Opportunities: ACTIVE/PAST groups, stage bar, domain action, Open full view → Talent × Requisition 360', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        opportunities: {
          active: makeModel().opportunities?.active ?? [],
          closed: [{ pipeline_id: 'p9', requisition_id: 'r9', requisition_code: 'REQ-0877', client_name: 'Wells Fargo', role_title: 'Scrum Master', outcome: 'not_selected', reason: null, closed_at: '2026-06-01T00:00:00Z', open_journey_href: '/x' }],
        },
      }),
    );
    renderView('/talent/tal-1?section=opps');
    const card = await screen.findByTestId('t360-opps');
    expect(within(card).getByText('ACTIVE · 2')).toBeInTheDocument();
    expect(within(card).getByText('PAST · 1')).toBeInTheDocument();
    expect(within(card).getByText('Reason not recorded')).toBeInTheDocument();
    expect(within(card).getAllByRole('link', { name: 'Open full view ↗' })[0]).toHaveAttribute('href', '/requisitions/r1/talent/tal-1');
    expect(within(card).getByRole('link', { name: 'Open interview' })).toHaveAttribute('href', '/requisitions/r1');
    expect(within(card).getAllByText(/Stage 7 of 8/).length).toBeGreaterThan(0);
  });

  it('Activity: category filters with authoritative counts', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=activity');
    const card = await screen.findByTestId('t360-activity');
    expect(within(card).getByRole('button', { name: /Communications 1/ })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /Client 0/ }));
    expect(within(card).getByText('No activity of this type yet.')).toBeInTheDocument();
  });

  it('Notes: adds a talent-level note via the existing createNote and lists notes newest first', async () => {
    act.listActivities.mockResolvedValue({
      items: [{ id: 'n1', type: 'note', notes: 'Prefers hybrid', created_by_id: null, created_at: '2026-09-29T00:00:00Z', redacted_at: null }],
    });
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=notes');
    expect(await screen.findByText('Prefers hybrid')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Open to W2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(act.createNote).toHaveBeenCalledWith({ type: 'note', subject_type: 'talent_record', subject_id: 'tal-1', notes: 'Open to W2' }),
    );
  });

  it('Talent Trust: claims with named states (no scores); "Not the same person" dismisses the advisory (identity:resolve)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=trust');
    const trust = await screen.findByTestId('t360-trust');
    expect(within(trust).getByText('Each claim shows what supports it. No scores.')).toBeInTheDocument();
    expect(within(trust).getByText('Review needed')).toBeInTheDocument();
    fireEvent.click(within(trust).getByRole('button', { name: 'Not the same person' }));
    await waitFor(() => expect(adv.dismissAdvisory).toHaveBeenCalledWith('adv1'));
    fireEvent.click(within(trust).getByRole('button', { name: 'Consent history →' }));
    expect(await screen.findByTestId('consent-history')).toHaveTextContent('tal-1');
  });

  it('Talent Trust: "Record consent" opens the capture dialog when recruiting contact is not permitted', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        header: {
          ...makeModel().header,
          contactability: { summary: 'do_not_contact', recruiting_permitted: false, email_permitted: false, phone_permitted: false, sms_permitted: false },
        },
      }),
    );
    renderView('/talent/tal-1?section=trust');
    fireEvent.click(await screen.findByRole('button', { name: 'Record consent' }));
    expect(await screen.findByTestId('record-consent-dialog')).toBeInTheDocument();
  });

  it('Conversation Intelligence and Technical Screening render their empty states (no data source wired)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=ci');
    expect(await screen.findByText('No recorded conversations yet.')).toBeInTheDocument();
    fireEvent.click(within(nav()).getByRole('button', { name: /Technical Screening/ }));
    expect(await screen.findByText('No technical screenings yet.')).toBeInTheDocument();
  });

  it('a scope-hidden section shows an access notice (documents null)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel({ documents: null }));
    renderView('/talent/tal-1?section=docs');
    expect(await screen.findByText('You don’t have access to this section.')).toBeInTheDocument();
  });

  it('surfaces a retry affordance on load error', async () => {
    getTalent360Mock.mockRejectedValue(new Error('boom'));
    renderView();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Talent360View — Profile: full record, read-only (§8A)', () => {
  it('loads the full record, work history and work-authorization state with the page (A4)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByRole('heading', { name: 'Divya Vasudevan', level: 1 });
    await waitFor(() => expect(tal.getTalent).toHaveBeenCalledWith('tal-1'));
    expect(tal.getTalentWorkHistory).toHaveBeenCalledWith('tal-1');
    expect(tal.getTalentWorkAuthorizationState).toHaveBeenCalledWith('tal-1');
    // Header shows "<title> · <current employer>" on Overview too.
    expect(await screen.findByText('Scrum Master / Product Owner · Freddie Mac')).toBeInTheDocument();
  });

  it('Work authorization: "Declared · date" from the governed state; sponsorship is never the uncollected default (A2)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b4 = await screen.findByTestId('t360-pblock-04');
    await waitFor(() => expect(within(b4).getByText('Declared · Sep 23, 2026')).toBeInTheDocument());
    expect(within(b4).getByText('Sponsorship').nextSibling).toHaveTextContent('—Not collected yet');
    expect(within(b4).queryByText('Not required')).toBeNull();
  });

  it('Profile hides contact channels for a do-not-contact talent (INC-2 Correction A), read and edit', async () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
    getTalent360Mock.mockResolvedValue(
      makeModel({
        header: {
          ...makeModel().header,
          email: null,
          phone: null,
          contactability: { summary: 'do_not_contact', recruiting_permitted: false, email_permitted: false, phone_permitted: false, sms_permitted: false },
        },
      }),
    );
    renderView('/talent/tal-1?section=profile');
    const b1 = await screen.findByTestId('t360-pblock-01');
    await waitFor(() => expect(within(b1).getAllByText('Hidden · do not contact')).toHaveLength(2));
    for (const raw of ['divya@example.com', '571-307-0783', '703-555-0100']) expect(within(b1).queryByText(raw, { exact: false })).toBeNull();
    fireEvent.click(within(b1).getByRole('button', { name: /Edit/ }));
    expect(within(b1).getAllByText('Hidden · do not contact')).toHaveLength(2);
    expect(within(b1).queryByLabelText('Home phone')).toBeNull();
    expect(within(b1).queryByDisplayValue('703-555-0100')).toBeNull();
    expect(b1.textContent).not.toContain('divya@example.com');
  });

  it('per-field source lines come from the provenance read (A3)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b1 = await screen.findByTestId('t360-pblock-01');
    await waitFor(() => expect(within(b1).getByText('From resume')).toBeInTheDocument());
    expect(within(screen.getByTestId('t360-pblock-05')).getByText('Entered manually')).toBeInTheDocument();
  });

  it('Work authorization section edits Status in place (Update → Save)', async () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=auth');
    const card = await screen.findByTestId('t360-auth');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Update' })).toBeInTheDocument());
    fireEvent.click(within(card).getByRole('button', { name: 'Update' }));
    fireEvent.change(within(card).getByLabelText('Status'), { target: { value: 'US_CITIZEN' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tal.updateTalent).toHaveBeenCalledWith('tal-1', { work_authorization: 'US_CITIZEN' }));
  });

  it('Documents: the resume panel (preview + upload) is reused from Edit talent (D3)', async () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=docs');
    expect(await screen.findByTestId('resume-panel')).toHaveTextContent('tal-1:rw');
  });

  it('renders the ten blocks in Edit-talent order with exact labels; empty values show —', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b1 = await screen.findByTestId('t360-pblock-01');
    const order = ['01', '02', '03', '04', '05', '07', '08', '06', '09', '10'];
    for (const n of order) expect(screen.getByTestId(`t360-pblock-${n}`)).toBeInTheDocument();
    await waitFor(() => expect(within(b1).getByText('Home / work phone')).toBeInTheDocument());
    expect(within(b1).getByText('703-555-0100')).toBeInTheDocument();
    expect(within(b1).queryByText('Secondary email')).toBeNull(); // hide if empty
    expect(within(b1).getByText('Best time to call').nextSibling).toHaveTextContent('—');
    expect(within(b1).getByRole('link', { name: 'divya.example.com/portfolio' })).toHaveAttribute('href', 'https://divya.example.com/portfolio');
    expect(within(b1).getByText('Confirmed by SMS code')).toBeInTheDocument();
    expect(within(screen.getByTestId('t360-pblock-02')).getByText('Vienna, VA 22181')).toBeInTheDocument();
    expect(within(screen.getByTestId('t360-pblock-03')).getByText('Freddie Mac')).toBeInTheDocument();
    expect(within(screen.getByTestId('t360-pblock-08')).getByText(/Prefers hybrid\./)).toBeInTheDocument();
    expect(within(screen.getByTestId('t360-pblock-08')).getByText('Separate from activity Notes')).toBeInTheDocument();
    expect(within(screen.getByTestId('t360-pblock-10')).getByText('Saved when the talent was created — not readable yet.')).toBeInTheDocument();
  });

  it('work history shows every declared role, newest first', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b9 = await screen.findByTestId('t360-pblock-09');
    await waitFor(() => expect(within(b9).getAllByText(/Scrum Coach|Senior System Analyst/)).toHaveLength(2));
    const roles = within(b9).getAllByText(/Scrum Coach|Senior System Analyst/).map((n) => n.textContent);
    expect(roles).toEqual(['Scrum Coach', 'Senior System Analyst']);
    expect(within(b9).getByText('2025 – Present')).toBeInTheDocument();
  });

  it('header shows <title> · <current employer> once the full record loads', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    expect(await screen.findByText('Scrum Master / Product Owner · Freddie Mac')).toBeInTheDocument();
  });

  it('current pay is hidden without compensation:view:pay (A1)', async () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b5 = await screen.findByTestId('t360-pblock-05');
    await waitFor(() => expect(within(b5).getByText('Hot talent').nextSibling).toHaveTextContent('No'));
    expect(within(b5).queryByText('Current pay')).toBeNull();
  });

  it('current pay row shows with compensation:view:pay (A1)', async () => {
    h.scopes = [...BASE_SCOPES, 'compensation:view:pay'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b5 = await screen.findByTestId('t360-pblock-05');
    await waitFor(() => expect(within(b5).getByText('$65/hr')).toBeInTheDocument());
    expect(within(b5).getByText('Visible to recruiters only')).toBeInTheDocument();
  });

  it('falls back to the Talent 360 read when the full record 404s: no banner, no Edit', async () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
    tal.getTalent.mockRejectedValue(new Error('404'));
    tal.getTalentWorkHistory.mockRejectedValue(new Error('404'));
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    const b1 = await screen.findByTestId('t360-pblock-01');
    await waitFor(() => expect(screen.queryByText('Loading the talent record…')).toBeNull());
    expect(within(b1).getByText('divya@example.com')).toBeInTheDocument();
    expect(within(b1).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(screen.getByTestId('t360-pblock-09')).getByText('No work history on record.')).toBeInTheDocument();
  });
});

describe('Talent360View — Profile inline edit (§8A.7)', () => {
  const EDITOR = () => {
    h.scopes = [...BASE_SCOPES, 'talent:edit'];
  };
  async function openProfile(): Promise<void> {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Location' })).toBeInTheDocument());
  }

  it('no Edit anywhere without talent:edit (read-only caption)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView('/talent/tal-1?section=profile');
    await waitFor(() => expect(screen.getByText('Read-only · you don’t have permission to edit talent.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open Edit talent' })).toBeNull();
  });

  it('one card at a time: Edit switches the card in place; others are disabled; Cancel discards', async () => {
    EDITOR();
    await openProfile();
    expect(screen.getByRole('link', { name: 'Open Edit talent' })).toHaveAttribute('href', '/talent/tal-1/edit');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Location' }));
    const b2 = screen.getByTestId('t360-pblock-02');
    expect(within(b2).getByLabelText('City')).toHaveValue('Vienna');
    expect(screen.getByRole('button', { name: 'Edit Professional' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Edit Professional' })).toHaveAttribute('title', 'Save or cancel the open card first');
    fireEvent.change(within(b2).getByLabelText('City'), { target: { value: 'Reston' } });
    fireEvent.click(within(b2).getByRole('button', { name: 'Cancel' }));
    expect(within(b2).getByText('Vienna, VA 22181')).toBeInTheDocument();
    expect(tal.updateTalent).not.toHaveBeenCalled();
  });

  it('Save sends only the card’s changed fields via the existing PATCH and shows the server values', async () => {
    EDITOR();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Location' }));
    const b2 = screen.getByTestId('t360-pblock-02');
    fireEvent.change(within(b2).getByLabelText('City'), { target: { value: 'Reston' } });
    fireEvent.click(within(b2).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tal.updateTalent).toHaveBeenCalledWith('tal-1', { city: 'Reston' }));
    expect(await within(b2).findByText('Reston, VA 22181')).toBeInTheDocument();
    expect(within(b2).getByText('Updated just now by you')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Location saved · 1 field updated');
  });

  it('identity anchors are locked; required fields block the save', async () => {
    EDITOR();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Identity & contact' }));
    const b1 = screen.getByTestId('t360-pblock-01');
    expect(within(b1).queryByLabelText('Primary email')).toBeNull();
    expect(within(b1).getAllByText('Identity anchor · change through identity review')).toHaveLength(2);
    fireEvent.change(within(b1).getByLabelText('First name'), { target: { value: ' ' } });
    fireEvent.click(within(b1).getByRole('button', { name: 'Save' }));
    expect(within(b1).getByText('Required')).toBeInTheDocument();
    expect(tal.updateTalent).not.toHaveBeenCalled();
  });

  it('no changes → closes with a “no changes” toast and no PATCH', async () => {
    EDITOR();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Recruiter notes' }));
    fireEvent.click(within(screen.getByTestId('t360-pblock-08')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Recruiter notes saved · no changes');
    expect(tal.updateTalent).not.toHaveBeenCalled();
  });

  it('a server error keeps the card open with the entered values', async () => {
    EDITOR();
    tal.updateTalent.mockRejectedValueOnce(new Error('boom'));
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Professional' }));
    const b3 = screen.getByTestId('t360-pblock-03');
    fireEvent.change(within(b3).getByLabelText('Current employer'), { target: { value: 'Fannie Mae' } });
    fireEvent.click(within(b3).getByRole('button', { name: 'Save' }));
    expect(await within(b3).findByRole('alert')).toBeInTheDocument();
    expect(within(b3).getByLabelText('Current employer')).toHaveValue('Fannie Mae');
  });

  it('Skills: remove a chip and add one (duplicates ignored) → key_skills', async () => {
    EDITOR();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Skills' }));
    const b6 = screen.getByTestId('t360-pblock-06');
    fireEvent.click(within(b6).getByRole('button', { name: 'Remove SAFe' }));
    const add = within(b6).getByLabelText('Add a skill');
    fireEvent.change(add, { target: { value: 'scrum' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.change(add, { target: { value: 'Kanban' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(within(b6).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tal.updateTalent).toHaveBeenCalledWith('tal-1', { key_skills: 'Scrum, Kanban' }));
  });

  it('Work history: + Add role at the top, required role/org, replace-set PATCH, then re-read', async () => {
    EDITOR();
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work history' }));
    const b9 = screen.getByTestId('t360-pblock-09');
    fireEvent.click(within(b9).getByRole('button', { name: '+ Add role' }));
    fireEvent.click(within(b9).getByRole('button', { name: 'Save' }));
    expect(within(b9).getAllByText('Required')).toHaveLength(2);
    fireEvent.change(within(b9).getByLabelText('Role 1'), { target: { value: 'Agile Coach' } });
    fireEvent.change(within(b9).getByLabelText('Organization 1'), { target: { value: 'Capital One' } });
    tal.getTalentWorkHistory.mockClear();
    fireEvent.click(within(b9).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tal.updateTalent).toHaveBeenCalled());
    const body = tal.updateTalent.mock.calls[0]?.[1] as { work_history: { role_title: string }[] };
    expect(body.work_history.map((w) => w.role_title)).toEqual(['Agile Coach', 'Senior System Analyst', 'Scrum Coach']);
    await waitFor(() => expect(tal.getTalentWorkHistory).toHaveBeenCalledWith('tal-1'));
  });
});
