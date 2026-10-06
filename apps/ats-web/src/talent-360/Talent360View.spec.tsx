import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
vi.mock('../activity/activity-api', () => ({ createNote: vi.fn().mockResolvedValue({}) }));

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

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/talent/tal-1']}>
      <Routes>
        <Route path="/talent/:talentId" element={<Talent360View />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.scopes = [...BASE_SCOPES];
  h.createTask.mockResolvedValue({});
  h.updateTask.mockResolvedValue({});
  h.listTalentMemberships.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe('Talent360View — renders the composed contract, owns only presentation state', () => {
  it('Contactability action-first: "Record consent" shows when not permitted and opens the capture dialog', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        header: {
          ...makeModel().header,
          contactability: {
            summary: 'do_not_contact',
            recruiting_permitted: false,
            email_permitted: false,
            phone_permitted: false,
            sms_permitted: false,
          },
        },
      }),
    );
    renderView();
    const btn = await screen.findByRole('button', { name: 'Record consent' });
    expect(screen.getByText('No recruiting-contact consent recorded.')).toBeTruthy();
    fireEvent.click(btn);
    expect(await screen.findByTestId('record-consent-dialog')).toBeTruthy();
  });

  it('Contactability status-first: shows "Consent recorded" and no action when permitted', async () => {
    getTalent360Mock.mockResolvedValue(makeModel()); // contactable by default
    renderView();
    expect(await screen.findByText('Consent recorded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record consent' })).toBeNull();
  });

  it('renders the header, badges, KPI strip and opportunities from the payload', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    expect(await screen.findByText('Divya Vasudevan', { selector: '.t360-name' })).toBeInTheDocument();
    expect(screen.getByText('Recruiting ready')).toBeInTheDocument();
    expect(screen.getByText('Contact permitted')).toBeInTheDocument();
    expect(screen.getAllByText('REQ-1001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Freddie Mac').length).toBeGreaterThan(0);
    // KPI/opportunity values come from the payload, not re-derived.
    expect(screen.getByText('Client interview today')).toBeInTheDocument();
  });

  it('expands an opportunity to reveal its journey step strip on click', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    const row = await screen.findByText('Freddie Mac');
    fireEvent.click(row);
    // The 7-step journey strip appears in the expansion.
    await waitFor(() => expect(screen.getByText(/Submitted/)).toBeInTheDocument());
    expect(screen.getByText('Open journey')).toBeInTheDocument();
  });

  it('opens the Email composer directly when there is exactly one active opportunity', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        opportunities: {
          active: [
            { pipeline_id: 'p1', requisition_id: 'r1', requisition_code: 'REQ-1001', client_name: 'Freddie Mac', role_title: 'Scrum Master', stage: 'INTERVIEW', contextual_state: null, age_label: null, owner_label: null, next_action: null, open_journey_href: '/requisitions/r1', journey: journey('r1', {}) },
          ],
          closed: [],
        },
        relationship_strip: { active_opportunities: 1, submittals: 0, interviews_today: 0, offers: 0, assignments: 0, last_contact: null },
      }),
    );
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Email' }));
    expect(await screen.findByTestId('email-composer')).toHaveTextContent('r1');
  });

  it('opens the General Talent Contact composer when there is NO active opportunity (W1-A3, Talent-only)', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        opportunities: { active: [], closed: [] },
        relationship_strip: { active_opportunities: 0, submittals: 0, interviews_today: 0, offers: 0, assignments: 0, last_contact: null },
        attention: [],
      }),
    );
    renderView();
    // Email is ENABLED without an active opportunity (can_email + recruiting_permitted).
    fireEvent.click(await screen.findByRole('button', { name: 'Email' }));
    expect(await screen.findByTestId('general-email-composer')).toBeInTheDocument();
    // It is NOT the requisition-contact composer.
    expect(screen.queryByTestId('email-composer')).not.toBeInTheDocument();
  });

  it('hides a section (renders nothing) when its scope is not authorized (documents null)', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({ documents: null, authorized_sections: { opportunities: true, attention: true, tasks: true, activity: true, communications: true, documents: false, identity: true } }),
    );
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    // The Documents SECTION (its "All N documents" link + rows) is gone; the tab
    // label still exists, so assert the section content is absent, not the tab.
    expect(screen.queryByText(/All 3 documents/)).not.toBeInTheDocument();
    expect(screen.queryByText('Right to Represent · Freddie Mac')).not.toBeInTheDocument();
  });

  it('shows the authorized-but-empty opportunities state (no fabricated warning)', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({
        opportunities: { active: [], closed: [] },
        relationship_strip: { active_opportunities: 0, submittals: 0, interviews_today: 0, offers: 0, assignments: 0, last_contact: null },
        attention: [],
      }),
    );
    renderView();
    expect(await screen.findByText('No active opportunities right now.')).toBeInTheDocument();
  });

  it('renders the recruiter-facing Trust & Evidence projection (claim → evidence → state, no number)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('tab', { name: /Trust & Evidence/ }));
    // The recruiter-facing adapter: a subtitle that commits to "never an opaque
    // number", and claim rows projected from the authoritative identity facts —
    // not the internal dimension/anchor/evidence-timeline dump.
    expect(await screen.findByText(/never an opaque number/i)).toBeInTheDocument();
    expect(screen.getByText('Identity · email and mobile')).toBeInTheDocument();
    expect(screen.getByText('Duplicate check')).toBeInTheDocument();
  });

  it('keeps the full right rail on a non-overview tab (attention · tasks · relationship)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    // Profile tab has no activity filter chips, so these titles are unambiguous.
    fireEvent.click(await screen.findByRole('tab', { name: /Profile/ }));
    // The rail persists across tabs (not just Overview): all five cards render.
    expect(await screen.findByText('Your attention')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Relationship & ownership')).toBeInTheDocument();
    expect(screen.getByText('Contactability')).toBeInTheDocument();
  });

  it('renders the category filter chips with authoritative counts on the Activity tab', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('tab', { name: /Activity/ }));
    // Chips come from the fixed filter set; counts from category_counts (payload).
    expect(await screen.findByRole('button', { name: /Communications/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Requisitions/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Documents/ })).toBeInTheDocument();
  });

  it('shows the honest unavailable state for per-requisition contact evidence on Engagement', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('tab', { name: /Engagement/ }));
    // Contact-requirement geometry is preserved; per-req evidence is honestly
    // unavailable (never fabricated), while overall contactability still shows.
    expect(await screen.findByText('Contact requirement')).toBeInTheDocument();
    // One honest per-requisition row (evidence unavailable, never fabricated).
    expect(screen.getAllByText('Evidence unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('Consent state')).toBeInTheDocument();
    // The Communications timeline renders on the Engagement tab (prototype parity).
    expect(screen.getByText('Communications')).toBeInTheDocument();
  });

  it('renders the opportunity fact grid as fixed honest-empty slots (no commercial fields)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByText('Freddie Mac'));
    // Fixed slots present even when the contract does not supply them; BILL RATE
    // / commercial facts are deliberately absent (ruling R3).
    await waitFor(() => expect(screen.getByText('RECRUITER')).toBeInTheDocument());
    expect(screen.getByText('IN STAGE')).toBeInTheDocument();
    // The prototype's six slots are all present as labels — including the ones
    // the contract does not supply (ACCOUNT MANAGER / RTR / RESUME SUBMITTED) and
    // the R3-excluded BILL RATE — each rendered as an honest em-dash, value never
    // fabricated. Slot geometry preserved.
    expect(screen.getByText('ACCOUNT MANAGER')).toBeInTheDocument();
    expect(screen.getByText('RESUME SUBMITTED')).toBeInTheDocument();
    expect(screen.getByText('BILL RATE')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('surfaces a retry affordance on load error', async () => {
    getTalent360Mock.mockRejectedValue(new Error('boom'));
    renderView();
    expect(await screen.findByText('Retry')).toBeInTheDocument();
  });
});

describe('Talent360View — accessibility', () => {
  it('opportunity rows are keyboard-operable (role=button, aria-expanded, Enter expands)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    const oppRow = screen.getAllByRole('button', { expanded: false })[0] as HTMLElement;
    expect(oppRow).toBeDefined();
    expect(oppRow).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(oppRow, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Open journey')).toBeInTheDocument());
  });

  it('tabs expose tablist/tab semantics with aria-selected on the active tab', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Profile/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('header actions are real buttons (not clickable divs)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(screen.getByRole('button', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to requisition' })).toBeInTheDocument();
  });
});

// Scope a role query to the header's primary action cluster (the opportunities
// list also carries a "Follow up" next-action label — this disambiguates).
function headerFollowUp(container: HTMLElement): HTMLElement | null {
  const primary = container.querySelector('.t360-actions-primary');
  return primary === null
    ? null
    : within(primary as HTMLElement).queryByRole('button', { name: 'Follow up' });
}

describe('Talent360View — CRM-5 CRM deltas', () => {
  it('Lists rail card renders the saved lists this talent belongs to (reverse membership) + governed Add-to-list', async () => {
    h.scopes = [...BASE_SCOPES, 'saved-list:edit'];
    h.listTalentMemberships.mockResolvedValue([
      { item_id: 'tal-1', lists: [{ id: 'L1', name: 'Hot React', visibility: 'tenant' }] },
    ]);
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    // batch reverse-membership read, keyed by this talent.
    await waitFor(() => expect(screen.getByText('Hot React')).toBeInTheDocument());
    expect(h.listTalentMemberships).toHaveBeenCalledWith(['tal-1']);
    expect(screen.getAllByText('Shared').length).toBeGreaterThan(0); // tenant → Shared
    expect(screen.getAllByRole('button', { name: '+ Add to list' }).length).toBeGreaterThan(0);
  });

  it('Lists Add-to-list affordance is HIDDEN without saved-list:edit', async () => {
    getTalent360Mock.mockResolvedValue(makeModel()); // base scopes: no saved-list:edit
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(screen.queryByRole('button', { name: '+ Add to list' })).toBeNull();
  });

  it('relabels ownership as "Record added by" (provenance only — no Talent owner, HALT-2)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(screen.getAllByText('Record added by').length).toBeGreaterThan(0);
    expect(screen.queryByText('Record owner')).toBeNull();
  });

  it('Follow up header action is HIDDEN without task:write', async () => {
    getTalent360Mock.mockResolvedValue(makeModel()); // base: no task:write
    const { container } = renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(headerFollowUp(container)).toBeNull();
  });

  it('Follow up header action is SHOWN with task:write + contact permission', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(makeModel()); // recruiting_permitted: true
    const { container } = renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(headerFollowUp(container)).not.toBeNull();
  });

  it('Follow up header action is HIDDEN under contact-restriction (task:write but consent absent)', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(
      makeModel({
        header: {
          ...makeModel().header,
          contactability: {
            summary: 'do_not_contact',
            recruiting_permitted: false,
            email_permitted: false,
            phone_permitted: false,
            sms_permitted: false,
          },
        },
      }),
    );
    const { container } = renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(headerFollowUp(container)).toBeNull();
  });

  it('Tasks card checkbox COMPLETES a task via authoritative updateTask (task:write)', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    const complete = await screen.findByRole('button', { name: /^Complete:/ });
    fireEvent.click(complete);
    await waitFor(() => expect(h.updateTask).toHaveBeenCalledWith('t1', { status: 'done' }));
  });

  it('Tasks card shows a DISPLAY-ONLY indicator (no complete control) for a read-only actor', async () => {
    getTalent360Mock.mockResolvedValue(makeModel()); // base: no task:write
    renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    expect(screen.queryByRole('button', { name: /^Complete:/ })).toBeNull();
  });

  it('Follow up creates a REAL follow-up task assigned to the ACTOR by default (CRM-6 — the My Desk-surfacing fix)', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(makeModel());
    const { container } = renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    fireEvent.click(headerFollowUp(container) as HTMLElement);
    const reason = await screen.findByLabelText('Follow-up reason');
    fireEvent.change(reason, { target: { value: 'Call back next week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create follow-up' }));
    await waitFor(() =>
      expect(h.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Call back next week',
          owner_type: 'talent_record',
          owner_id: 'tal-1',
          type: 'follow_up',
          // the CRM-6 fix: assignee defaults to the actor (session.sub='u1'), so
          // the follow-up reaches the creator's My Desk (CRM-5 left it null).
          assignee_id: 'u1',
        }),
      ),
    );
  });

  it('Follow up carries the optional requisition context when one is picked (CRM-6 §10)', async () => {
    h.scopes = [...BASE_SCOPES, 'task:write'];
    getTalent360Mock.mockResolvedValue(makeModel()); // fixture has active opps r1/r2
    const { container } = renderView();
    await screen.findByText('Divya Vasudevan', { selector: '.t360-name' });
    fireEvent.click(headerFollowUp(container) as HTMLElement);
    const reason = await screen.findByLabelText('Follow-up reason');
    fireEvent.change(reason, { target: { value: 'Check client feedback' } });
    // the picker is fed from the Talent's OWN active opportunities.
    fireEvent.change(screen.getByLabelText('Follow-up requisition'), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create follow-up' }));
    await waitFor(() =>
      expect(h.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_type: 'talent_record',
          type: 'follow_up',
          requisition_id: 'r1',
        }),
      ),
    );
  });
});
