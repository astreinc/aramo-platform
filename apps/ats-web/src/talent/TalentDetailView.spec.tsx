import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { ActivityView } from '../activity/types';
import type { PipelineView } from '../pipeline/types';

import { TalentDetailView } from './TalentDetailView';
import type { AttachmentView, TalentRecordView } from './types';

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
    // Default: 404 for unmocked URLs (e.g. /auth/recruiter/session — the
    // sessionOverride prop makes the result irrelevant).
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

  it('renders the Identity tab with the talent name and pool-open framing', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByText(/from your tenant talent pool/i)).toBeInTheDocument();
    // Identity tab is selected; its fields render.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.getByText('Analytical Engines Ltd')).toBeInTheDocument();
  });

  it('hides scope-gated tabs when their scopes are absent', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt('/talent/tal-1', makeSession(['talent:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    // Only Identity is shown.
    expect(screen.getByRole('tab', { name: 'Identity' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Attachments' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Pipelines' })).toBeNull();
  });

  it('shows all four tabs when all per-tab scopes are granted', async () => {
    installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderAt(
      '/talent/tal-1',
      makeSession([
        'talent:read',
        'attachment:read',
        'activity:read',
        'pipeline:read',
      ]),
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Identity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Attachments' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pipelines' })).toBeInTheDocument();
  });

  it('Attachments tab hits owner_type=talent (ruling 1 — substrate truth)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/attachments': {
        items: [makeAttachment('att-1', 'resume.pdf')],
      },
    });
    renderAt(
      '/talent/tal-1',
      makeSession(['talent:read', 'attachment:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    await waitFor(() =>
      expect(screen.getByText('resume.pdf')).toBeInTheDocument(),
    );
    // Verify the URL used owner_type=talent (NOT 'talent_record').
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const attachmentCall = calls.find((c) => String(c[0]).includes('/v1/attachments'));
    expect(attachmentCall).toBeDefined();
    const url = String(attachmentCall?.[0]);
    expect(url).toContain('owner_type=talent');
    expect(url).not.toContain('owner_type=talent_record');
    expect(url).toContain('owner_id=tal-1');
  });

  it('Activity tab calls subject_type=talent_record', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/activities': { items: [makeActivity('a-1', 'Reached out')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'activity:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
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

  it('Pipelines tab hits /v1/pipelines?talent_record_id=:id (Gate-5 confirmed)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/pipelines': { items: [makePipeline('p-1', 'req-1')] },
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'pipeline:read']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Pipelines' }));
    await waitFor(() =>
      expect(screen.getByText(/Requisition req-1/)).toBeInTheDocument(),
    );
    // Status label appears (Contacted).
    expect(screen.getByText(/Contacted/)).toBeInTheDocument();
    // Link points at the req detail.
    const link = screen.getByRole('link', { name: /Requisition req-1/ });
    expect(link).toHaveAttribute('href', '/requisitions/req-1');
    // R6 — Submittal link is HIDDEN when submittal:create is not granted.
    expect(
      screen.queryByRole('link', { name: 'Submittal' }),
    ).not.toBeInTheDocument();
    // URL filter verification.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const pipelineCall = calls.find((c) => String(c[0]).includes('/v1/pipelines'));
    expect(String(pipelineCall?.[0])).toContain('talent_record_id=tal-1');
  });

  it('Pipelines tab renders a Submittal link when submittal:create is granted (R6 entry point)', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/pipelines': { items: [makePipeline('p-1', 'req-1')] },
    });
    renderAt(
      '/talent/tal-1',
      makeSession(['talent:read', 'pipeline:read', 'submittal:create']),
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Pipelines' }));
    await waitFor(() =>
      expect(screen.getByText(/Requisition req-1/)).toBeInTheDocument(),
    );
    const submittalLink = screen.getByRole('link', { name: 'Submittal' });
    expect(submittalLink).toHaveAttribute(
      'href',
      '/talent/tal-1/submittal/req-1',
    );
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
    // Back-link present.
    expect(
      screen.getByRole('link', { name: /back to talent/i }),
    ).toBeInTheDocument();
  });

  it('Attachments empty-state copy is honest', async () => {
    installFetch({
      '/v1/talent-records/tal-1': makeTalent(),
      '/v1/attachments': { items: [] },
    });
    renderAt(
      '/talent/tal-1',
      makeSession(['talent:read', 'attachment:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    await waitFor(() =>
      expect(
        screen.getByText(/no attachments for this talent record yet/i),
      ).toBeInTheDocument(),
    );
  });

  // TR-3 B2 — the email-verification affordance in the Identity panel. The
  // status GET shares the talent-record base path, so the more specific
  // /email-verifications pattern must be registered FIRST (installFetch matches
  // by insertion order).
  it('TR-3 B2 — with talent:edit + a pending status, the verify button renders, the pill reflects the fetched status, and clicking POSTs a verification request', async () => {
    installFetch({
      '/v1/talent-records/tal-1/email-verifications': {
        items: [
          { slot: 'email1', value_present: true, status: 'pending' },
          { slot: 'email2', value_present: false, status: 'none' },
        ],
      },
      '/v1/talent-records/tal-1': makeTalent(),
    });
    renderAt('/talent/tal-1', makeSession(['talent:read', 'talent:edit']));
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    // The pill reflects the fetched per-slot status (a band/label, not a number).
    await waitFor(() =>
      expect(screen.getByTestId('verify-status-email1')).toHaveTextContent(
        'Pending',
      ),
    );
    const btn = screen.getByTestId('verify-email-btn-email1');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find(
        (c) =>
          String(c[0]).includes('/v1/talent-records/tal-1/email-verifications') &&
          (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      // The stored SLOT is sent — never a free-form address.
      expect(String((post?.[1] as RequestInit).body)).toContain('email1');
    });
    // Optimistic disable after send.
    await waitFor(() =>
      expect(screen.getByTestId('verify-email-btn-email1')).toBeDisabled(),
    );
  });

  it('TR-3 B2 — without talent:edit the verify button is absent', async () => {
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
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    // The status pill still renders; the action does not.
    await waitFor(() =>
      expect(screen.getByTestId('verify-status-email1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('verify-email-btn-email1')).toBeNull();
  });
});
