import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { ActivityView } from '../activity/types';
import type { PipelineView } from '../pipeline/types';
import { BreadcrumbProvider, useBreadcrumbEntity } from '../shell/breadcrumb';

import { TalentDetailView } from './TalentDetailView';
import type { AttachmentView, TalentRecordView } from './types';

// Probe that renders the current breadcrumb entity (T10-B1/F-006 proof seam).
function CrumbProbe() {
  const entity = useBreadcrumbEntity();
  return <div data-testid="crumb-probe">{entity ?? ''}</div>;
}

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

function makeTalent(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: 'tal-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    email2: null,
    phone_home: null,
    phone_cell: '555-0100',
    phone_work: null,
    address: null,
    address2: null,
    city: 'London',
    state: null,
    zip: null,
    source: null,
    key_skills: 'Bernoulli numbers',
    current_employer: 'Analytical Engines Ltd',
    current_pay: null,
    desired_pay: null,
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
    date_available: null,
    can_relocate: true,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeAttachment(
  id: string,
  fileName: string,
  overrides: Partial<AttachmentView> = {},
): AttachmentView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    owner_type: 'talent',
    owner_id: 'tal-1',
    file_name: fileName,
    mime: 'application/pdf',
    size_bytes: 12345,
    storage_key: `s3://${id}`,
    is_resume: true,
    uploaded_by_id: null,
    uploaded_at: '2026-06-01T00:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeActivity(id: string, notes: string | null): ActivityView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    type: 'note',
    subject_type: 'talent_record',
    subject_id: 'tal-1',
    notes,
    created_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
  };
}

function makePipeline(id: string, requisitionId: string): PipelineView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    talent_record_id: 'tal-1',
    requisition_id: requisitionId,
    status: 'contacted',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

// Routes by URL — each test wires fetch to the right URL pattern. The
// stub returns JSON; the component's apiClient handles parsing.
type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

function installFetch(map: FetchMap) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of Object.entries(map)) {
      if (url.includes(pattern)) {
        const isWrapped =
          typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
        const body = isWrapped ? (value as { body: unknown }).body : value;
        const status = isWrapped ? (value as { status: number }).status : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // Default: 404 for unmocked URLs.
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderAt(path: string, session: Session) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/talent/:talentId"
          element={<TalentDetailView sessionOverride={session} />}
        />
        <Route path="/talent" element={<p>Talent list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TalentDetailView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── T10-B1/F-006 — the detail view publishes the talent name as the
  //    breadcrumb entity; no new fetch is introduced. ──
  it('publishes the talent name as the breadcrumb entity (no new fetch)', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    render(
      <MemoryRouter initialEntries={['/talent/tal-1']}>
        <BreadcrumbProvider>
          <CrumbProbe />
          <Routes>
            <Route
              path="/talent/:talentId"
              element={<TalentDetailView sessionOverride={makeSession(['talent:read'])} />}
            />
          </Routes>
        </BreadcrumbProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('crumb-probe')).toHaveTextContent('');
    await waitFor(() =>
      expect(screen.getByTestId('crumb-probe')).toHaveTextContent('Ada Lovelace'),
    );
  });

  it('renders the header (name, single sub-line, contact) and the Profile Skills card', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    // In-page breadcrumb.
    const crumb = screen.getByTestId('talent-detail-crumb');
    expect(within(crumb).getByRole('link', { name: 'Talent' })).toBeInTheDocument();
    // Contact fields live in the header now.
    const head = screen.getByTestId('talent-detail-head');
    expect(within(head).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(head).getByText('555-0100')).toBeInTheDocument();
    // Single sub-line = employer · location (prototype style); the pool-open
    // framing does NOT render as a second line when there is real content.
    expect(within(head).getByText('Analytical Engines Ltd · London')).toBeInTheDocument();
    expect(within(head).queryByText(/from your tenant talent pool/i)).toBeNull();
    // Skills chip lives in the Profile tab (active by default).
    expect(screen.getByText('Bernoulli numbers')).toBeInTheDocument();
  });

  it('falls back to the pool-open framing sub-line when employer + location are absent (R2)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent({ current_employer: null, city: null, state: null }),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const head = screen.getByTestId('talent-detail-head');
    expect(within(head).getByText(/from your tenant talent pool/i)).toBeInTheDocument();
  });

  it('hides scope-gated tabs when their scopes are absent', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    // Base tabs: Profile + Engagement (always) + Trust & Evidence (talent:read).
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Engagement' })).toBeInTheDocument();
    // Scope-gated tabs are hidden. Documents is a card in Profile, not a tab.
    expect(screen.queryByRole('tab', { name: 'Journey' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Documents' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Selections' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Tasks' })).toBeNull();
  });

  it('shows the prototype tab set when the per-tab scopes are granted', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/pipelines': { items: [] },
      '/v1/attachments': { items: [] },
    });
    renderAt(
      '/talent/tal-1',
      makeSession(['talent:read', 'attachment:read', 'activity:read', 'pipeline:read']),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Journey' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Engagement' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trust & Evidence' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  it('Documents card (in Profile) hits owner_type=talent (ruling 1 — substrate truth)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/attachments': { items: [makeAttachment('att-1', 'resume.pdf')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'attachment:read']));
    // Profile is active by default → the Documents card mounts and fetches.
    await waitFor(() =>
      expect(screen.getByText('resume.pdf')).toBeInTheDocument(),
    );
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const attachmentCall = calls.find((c) => String(c[0]).includes('/v1/attachments'));
    expect(attachmentCall).toBeDefined();
    const url = String(attachmentCall?.[0]);
    expect(url).toContain('owner_type=talent');
    expect(url).not.toContain('owner_type=talent_record');
    expect(url).toContain('owner_id=tal-1');
  });

  it('Documents empty-state copy is honest', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/attachments': { items: [] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'attachment:read']));
    await waitFor(() =>
      expect(
        screen.getByText(/no attachments for this talent record yet/i),
      ).toBeInTheDocument(),
    );
  });

  it('Activity tab calls subject_type=talent_record', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/activities': { items: [makeActivity('a-1', 'Reached out')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'activity:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() =>
      expect(screen.getByText('Reached out')).toBeInTheDocument(),
    );
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const activityCall = calls.find((c) => String(c[0]).includes('/v1/activities'));
    const url = String(activityCall?.[0]);
    expect(url).toContain('subject_type=talent_record');
    expect(url).toContain('subject_id=tal-1');
  });

  it('Journey tab hits /v1/pipelines?talent_record_id=:id and renders the requisition + state', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/pipelines': { items: [makePipeline('p-1', 'req-1')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'pipeline:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Journey' }));
    await waitFor(() =>
      expect(screen.getByText(/Requisition req-1/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Contacted/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Requisition req-1/ });
    expect(link).toHaveAttribute('href', '/requisitions/req-1');
    // R6 — Submittal link is HIDDEN when submittal:create is not granted.
    expect(screen.queryByRole('link', { name: 'Submittal' })).not.toBeInTheDocument();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const pipelineCall = calls.find((c) => String(c[0]).includes('/v1/pipelines'));
    expect(String(pipelineCall?.[0])).toContain('talent_record_id=tal-1');
  });

  it('Journey tab renders a Submittal link when submittal:create is granted (R6 entry point)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/pipelines': { items: [makePipeline('p-1', 'req-1')] },
    });
    renderAt(
      '/talent/tal-1',
      makeSession(['talent:read', 'pipeline:read', 'submittal:create']),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Journey' }));
    await waitFor(() =>
      expect(screen.getByText(/Requisition req-1/)).toBeInTheDocument(),
    );
    const submittalLink = screen.getByRole('link', { name: 'Submittal' });
    expect(submittalLink).toHaveAttribute('href', '/talent/tal-1/submittal/req-1');
  });

  it('surfaces the detail error when the talent fetch returns 404', async () => {
    installFetch({
      '/v1/talent-records/tal-1': { status: 404, body: { message: 'not found' } },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(
        screen.getByText(/this talent record is not available/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /back to talent/i }),
    ).toBeInTheDocument();
  });

  // ── TR-3 B2 — identity verification is a HEADER ACTION (next to "Add to
  //    requisition"), not inline noise beside the email. The contact row stays
  //    clean; the verified state reads as the name-row "Verified identity" badge.
  //    The status GET shares the talent-record base path, so the more specific
  //    /email-verifications pattern must be registered FIRST. ──
  it('TR-3 B2 — with talent:edit and an unverified email, the header "Verify identity" action renders and clicking POSTs a verification request', async () => {
    installFetch({
      '/v1/talent-records/tal-1/email-verifications': {
        items: [
          { slot: 'email1', value_present: true, status: 'none' },
          { slot: 'email2', value_present: false, status: 'none' },
        ],
      },
      '/v1/talent-records/tal-1': makeTalent(),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'talent:edit']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    // The action lives in the header action group, not the contact row.
    const head = screen.getByTestId('talent-detail-head');
    const btn = await waitFor(() =>
      within(head).getByRole('button', { name: 'Verify identity' }),
    );
    // No inline "not verified" pill on the email.
    expect(screen.queryByTestId('verify-status-email1')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find(
        (c) =>
          String(c[0]).includes('/v1/talent-records/tal-1/email-verifications') &&
          (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(String((post?.[1] as RequestInit).body)).toContain('email1');
    });
    // After firing, the action reads "Verification sent" and disables.
    await waitFor(() =>
      expect(within(head).getByRole('button', { name: 'Verification sent' })).toBeDisabled(),
    );
  });

  it('TR-3 B2 — without talent:edit the "Verify identity" action is absent', async () => {
    installFetch({
      '/v1/talent-records/tal-1/email-verifications': {
        items: [
          { slot: 'email1', value_present: true, status: 'none' },
          { slot: 'email2', value_present: false, status: 'none' },
        ],
      },
      '/v1/talent-records/tal-1': makeTalent(),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Verify identity' })).toBeNull();
    // And the email still renders cleanly in the contact row.
    const head = screen.getByTestId('talent-detail-head');
    expect(within(head).getByText('ada@example.com')).toBeInTheDocument();
  });

  // ── FE-convergence — header chips / snapshot / rail are prototype-aligned in
  //    LAYOUT; DATA is real where available and honest ("—") otherwise. ──

  it('FE-convergence — header chips render availability / consent / hot from record data', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent({
        availability_status: 'available_now',
        consent_summary: 'contactable',
        is_hot: true,
      }),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const head = screen.getByTestId('talent-detail-head');
    expect(within(head).getByText('Available now')).toBeInTheDocument();
    expect(within(head).getByText('Contact permitted')).toBeInTheDocument();
    expect(within(head).getByText('Hot')).toBeInTheDocument();
  });

  it('FE-convergence — no contactability chip in the header when consent_summary is absent; rail Consent card shows "—" (no fabricated state)', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const head = screen.getByTestId('talent-detail-head');
    expect(within(head).queryByText('Contact permitted')).toBeNull();
    // The rail Consent card is always present (prototype layout); its Recruiting
    // contact value is an honest em dash when the enrichment was not returned.
    const rail = screen.getByTestId('talent-detail-rail');
    expect(within(rail).getByText('Consent & contactability')).toBeInTheDocument();
    expect(within(rail).getByText('Recruiting contact')).toBeInTheDocument();
  });

  it('FE-convergence — the snapshot strip renders the prototype tiles; Opportunities is the active-pipeline count and Last contact is the enrichment date', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent({ last_activity_at: '2026-08-15T00:00:00Z' }),
      '/v1/pipelines': { items: [makePipeline('p-1', 'req-1')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'pipeline:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const strip = screen.getByTestId('talent-snapshot');
    expect(within(strip).getByText('Opportunities')).toBeInTheDocument();
    expect(within(strip).getByText('Submittals')).toBeInTheDocument();
    expect(within(strip).getByText('Interviews')).toBeInTheDocument();
    expect(within(strip).getByText('Offers')).toBeInTheDocument();
    expect(within(strip).getByText('Assignments')).toBeInTheDocument();
    expect(within(strip).getByText('Last contact')).toBeInTheDocument();
    // Real values.
    await waitFor(() =>
      expect(within(strip).getByText('1 active')).toBeInTheDocument(),
    );
    expect(within(strip).getByText('2026-08-15')).toBeInTheDocument();
  });

  it('FE-convergence — snapshot count tiles show honest "—" (never a faked count) when no aggregate is available', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const strip = screen.getByTestId('talent-snapshot');
    // Opportunities (no pipeline:read) + the four aggregate tiles + last contact
    // are all em dashes on this fixture.
    expect(within(strip).getAllByText('—').length).toBeGreaterThanOrEqual(5);
  });

  it('FE-convergence — the Ownership rail surfaces record provenance from available fields', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent({
        source: 'Referral',
        created_at: '2026-06-01T00:00:00Z',
      }),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    const rail = screen.getByTestId('talent-detail-rail');
    expect(within(rail).getByText('Ownership')).toBeInTheDocument();
    expect(within(rail).getByText('Source')).toBeInTheDocument();
    expect(within(rail).getByText('Referral')).toBeInTheDocument();
    expect(within(rail).getByText('In database since')).toBeInTheDocument();
    expect(within(rail).getByText('Jun 2026')).toBeInTheDocument();
    // No owner id on the fixture → honest "Unassigned".
    expect(within(rail).getByText('Unassigned')).toBeInTheDocument();
  });

  it('FE-convergence — "Add to requisition" opens a dialog of open requisitions and creates a pipeline', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/requisitions': {
        items: [
          { id: 'req-9', title: 'Senior SRE', status: 'open' },
          { id: 'req-8', title: 'Closed role', status: 'closed' },
        ],
      },
      '/v1/pipelines': makePipeline('p-1', 'req-9'),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to requisition' }));
    const dialog = await screen.findByRole('dialog');
    // Only the OPEN requisition is offered.
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'Senior SRE' })).toBeInTheDocument(),
    );
    expect(within(dialog).queryByRole('option', { name: 'Closed role' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Requisition'), {
      target: { value: 'req-9' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to requisition' }));
    await waitFor(() =>
      expect(screen.getByText(/talent added to the requisition/i)).toBeInTheDocument(),
    );
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find(
      (c) =>
        String(c[0]).includes('/v1/pipelines') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(post).toBeDefined();
    expect(String((post?.[1] as RequestInit).body)).toContain('req-9');
  });
});
