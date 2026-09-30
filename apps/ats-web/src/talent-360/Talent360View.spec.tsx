import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../talent/components/TrustPanel', () => ({
  TrustPanel: ({ talentId }: { talentId: string }) => <div data-testid="trust-panel">{talentId}</div>,
}));
vi.mock('../talent/WorkHistoryPanel', () => ({
  WorkHistoryPanel: ({ talentId }: { talentId: string }) => <div data-testid="work-history">{talentId}</div>,
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
vi.mock('../activity/activity-api', () => ({ createNote: vi.fn().mockResolvedValue({}) }));
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
        scopes: ['talent:read', 'pipeline:read', 'task:read', 'activity:read', 'communication:read', 'document:read', 'identity:resolve'],
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
      ownership: { owner_provenance: { user_id: 'u1', name: 'Purush P.' }, also_working_with: [], source: 'LinkedIn sourcing', source_channel: null },
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

afterEach(() => vi.clearAllMocks());

describe('Talent360View — renders the composed contract, owns only presentation state', () => {
  it('renders the header, badges, KPI strip and opportunities from the payload', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    expect(await screen.findByText('Divya Vasudevan')).toBeInTheDocument();
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

  it('hides a section (renders nothing) when its scope is not authorized (documents null)', async () => {
    getTalent360Mock.mockResolvedValue(
      makeModel({ documents: null, authorized_sections: { opportunities: true, attention: true, tasks: true, activity: true, communications: true, documents: false, identity: true } }),
    );
    renderView();
    await screen.findByText('Divya Vasudevan');
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

  it('reuses the authoritative TrustPanel on the Trust & Evidence tab', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    fireEvent.click(await screen.findByRole('tab', { name: /Trust & Evidence/ }));
    expect(await screen.findByTestId('trust-panel')).toBeInTheDocument();
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
    await screen.findByText('Divya Vasudevan');
    const oppRow = screen.getAllByRole('button', { expanded: false })[0] as HTMLElement;
    expect(oppRow).toBeDefined();
    expect(oppRow).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(oppRow, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Open journey')).toBeInTheDocument());
  });

  it('tabs expose tablist/tab semantics with aria-selected on the active tab', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Profile/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('header actions are real buttons (not clickable divs)', async () => {
    getTalent360Mock.mockResolvedValue(makeModel());
    renderView();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByRole('button', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to requisition' })).toBeInTheDocument();
  });
});
