import {
  fireEvent,
  render as rawRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, type Session } from '@aramo/fe-foundation';

import { RequisitionDetailView } from './RequisitionDetailView';

// PR-A2 §4 P1/P2 — the cockpit integration proof: per-field affordance
// renders correctly off the masked payload, the headline UX is reachable,
// and a forced save the backend rejects (403) surfaces honestly (backend is
// truth). The heavy child surfaces (kanban / activity / tasks / profile
// workbench) are stubbed — each is proven in its own spec.

vi.mock('../activity/ActivityTimeline', () => ({
  ActivityTimeline: () => <div data-testid="activity" />,
}));
vi.mock('../activity/LogNoteDialog', () => ({
  LogNoteDialog: () => <div data-testid="log-note" />,
}));
vi.mock('../task/TasksPanel', () => ({
  TasksPanel: () => <div data-testid="tasks" />,
}));
vi.mock('../pipeline/pipeline-api', () => ({
  listPipelinesForRequisition: () => Promise.resolve({ items: [] }),
  getTalentRecord: () =>
    Promise.resolve({ id: 't', first_name: 'A', last_name: 'B' }),
  transitionPipeline: () => Promise.resolve(),
}));
vi.mock('./ProfileWorkbenchPanel', () => ({
  ProfileWorkbenchPanel: () => <div data-testid="profile-panel" />,
}));

// The cockpit (inline-edit sections + workbench) lives in the Overview tab
// (the scope-driven default for a requisition:read/edit actor with no pipeline/
// commercial/assignment scopes). Select it explicitly before asserting.
async function openDetails() {
  await screen.findByRole('heading', { name: /Senior Engineer/ });
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
}

function render(ui: ReactElement) {
  return rawRender(<ToastProvider>{ui}</ToastProvider>);
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

// The base (un-gated) requisition view — OPEN/enterprise/system fields are
// always present. Comp/financial keys are ABSENT (masked) unless added.
function baseView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-1',
    tenant_id: 't',
    site_id: null,
    title: 'Senior Engineer',
    requisition_number: 1000,
    company_id: 'co-1',
    contact_id: null,
    company_department_id: null,
    status: 'open',
    type: null,
    duration: null,
    description: null,
    notes: null,
    is_hot: false,
    openings: 2,
    openings_available: 2,
    capacity_balance: 2,
    start_date: null,
    city: 'NYC',
    state: null,
    recruiter_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    version: 0, // T1-e — read-then-write concurrency token
    job_type: null,
    labor_category: null,
    role_family: null,
    seniority_level: null,
    headcount_reason: null,
    work_arrangement: null,
    onsite_days_per_week: null,
    travel_percent: null,
    relocation_offered: false,
    work_authorization: null,
    end_date: null,
    duration_value: null,
    duration_unit: null,
    extension_possible: false,
    hours_per_week: null,
    source_system: null,
    external_req_id: null,
    imported_at: null,
    golden_profile_id: null,
    pending_approval_submitter_id: null,
    ...extra,
  };
}

interface MockedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(
  handler: (req: MockedRequest) => { status: number; body: unknown },
): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body !== undefined && init.body !== null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    const req: MockedRequest = { url, method, body };
    calls.push(req);
    const res = handler(req);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

function mount(session: Session) {
  return render(
    <MemoryRouter initialEntries={['/requisitions/req-1']}>
      <Routes>
        <Route
          path="/requisitions/:reqId"
          element={<RequisitionDetailView sessionOverride={session} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RequisitionDetailView Overview (G2.5a view mode)', () => {
  it('renders the shared form sections + profile panel for an entitled user', async () => {
    installFetch((req) => {
      if (req.method === 'GET' && req.url.includes('/v1/requisitions/req-1')) {
        return { status: 200, body: baseView() };
      }
      return { status: 404, body: {} };
    });
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    // The Overview is the shared RequisitionForm — its section cards, not the
    // old cockpit's Identity/Classification grouping.
    expect(screen.getByText('Role & client')).toBeInTheDocument();
    expect(screen.getByText('Job title')).toBeInTheDocument();
    expect(screen.getByTestId('profile-panel')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView Overview — view mode is read-only (G2.5a)', () => {
  it('shows fields as read-only value boxes with NO per-field edit affordance', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    // §5 — no per-field click-to-edit; whole-form edit arrives via the header
    // Edit button (G2.5b). The Overview renders no inputs in view mode.
    expect(screen.queryByRole('button', { name: /edit title/i })).toBeNull();
    expect(document.querySelector('.rc-ov-form input')).toBeNull();
    expect(document.querySelector('.rc-ov-form .rc-vbox')).not.toBeNull();
  });

  it('the Job title value renders read-only from the payload', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read']));
    await openDetails();
    const box = screen
      .getByText('Job title')
      .closest('.rc-ifield')
      ?.querySelector('.rc-vbox');
    expect(box?.textContent).toBe('Senior Engineer');
  });

  it('Commercials is ABSENT when the payload omits comp fields (masking by absence)', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    // bill_rate_amount is masked (omitted) → its row is not rendered.
    expect(
      screen.queryByText('Bill rate (max)'),
    ).toBeNull();
  });

  it('Commercials bill rate renders (read-only) when PRESENT in the payload', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ bill_rate_amount: '85.00' }),
    }));
    mount(makeSession(['requisition:read', 'compensation:view:bill']));
    await openDetails();
    expect(screen.getByText('Commercials')).toBeInTheDocument();
    const box = screen
      .getByText('Bill rate (max)')
      .closest('.rc-ifield')
      ?.querySelector('.rc-vbox');
    expect(box?.textContent).toContain('85.00');
  });
});

describe('RequisitionDetailView — status is DISPLAYED, not an editable cockpit select (L1-E)', () => {
  it('the header shows the status label read-only; there is NO cockpit status select', async () => {
    installFetch(() => ({ status: 200, body: baseView({ status: 'open' }) }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    // Status is displayed as state in the header pill (the h1 carries the label).
    const heading = await screen.findByRole('heading', { name: /Senior Engineer/ });
    expect(heading.textContent).toContain('Open');
    // ...but it is no longer a mutable cockpit field (no select row, no editor).
    await openDetails();
    expect(screen.queryByTestId('cockpit-field-status')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit status/i })).toBeNull();
  });
});

describe('RequisitionDetailView Overview — no inline save in view mode (G2.5a)', () => {
  it('view mode issues NO PATCH — there is no per-field save affordance', async () => {
    const calls = installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    // No inline editor to trigger a field PATCH (whole-form save is G2.5b).
    expect(screen.queryByRole('button', { name: /edit title/i })).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('RequisitionDetailView — PR-17 hybrid onsite frequency', () => {
  it('a hybrid requisition with onsite_days_per_week null renders plain "Hybrid" — never "· ? days"', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ work_arrangement: 'hybrid', onsite_days_per_week: null }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    // The location label reads "Hybrid" and carries no frequency suffix.
    expect(document.body.textContent).toContain('Hybrid');
    expect(document.body.textContent).not.toMatch(/on-site/i);
    expect(document.body.textContent).not.toMatch(/\?\s*day/i);
  });

  it('a hybrid requisition with a known frequency renders "Hybrid · N days on-site"', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ work_arrangement: 'hybrid', onsite_days_per_week: 3 }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    expect(document.body.textContent).toContain('Hybrid · 3 days on-site');
  });

  it('Onsite days / week is not an Overview form field (not in the prototype sections)', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ work_arrangement: 'hybrid', onsite_days_per_week: 3 }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    // The onsite frequency drives only the header arrangement suffix; it is not
    // one of the §5 form fields.
    expect(screen.queryByText('Onsite days / week')).toBeNull();
    expect(screen.queryByTestId('cockpit-field-onsite_days_per_week')).toBeNull();
  });
});

describe('RequisitionDetailView — PR-15 internal requisition number', () => {
  it('renders the internal number as REQ-{number} (presentation-only prefix)', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ requisition_number: 1000, external_req_id: null }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    expect(document.body.textContent).toContain('REQ-1000');
  });

  it('R4 — a requisition with NO external_req_id still renders correctly (REQ-{number} present)', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ requisition_number: 1042, external_req_id: null }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    // Renders without error and shows the internal number.
    expect(await screen.findByRole('heading', { name: /Senior Engineer/ })).toBeInTheDocument();
    expect(document.body.textContent).toContain('REQ-1042');
  });

  it('where both exist, the internal number is primary and external_req_id renders as secondary', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ requisition_number: 1007, external_req_id: 'VMS-88' }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    const text = document.body.textContent ?? '';
    expect(text).toContain('REQ-1007');
    expect(text).toContain('VMS-88');
    // Internal number appears before the external identifier in the header.
    expect(text.indexOf('REQ-1007')).toBeLessThan(text.indexOf('VMS-88'));
  });
});

describe('RequisitionDetailView Overview — edit mode + save (G2.5b)', () => {
  it('the header Edit button enters edit mode: fields become inputs + a sticky edit bar', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(/Editing REQ-1000\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Job title')).toHaveValue('Senior Engineer');
    // The button now reads "Editing".
    expect(screen.getByRole('button', { name: 'Editing' })).toBeInTheDocument();
  });

  it('Cancel discards changes and returns to view without a PATCH', async () => {
    const calls = installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: 'Changed Title' },
    });
    // Scope to the edit bar — the header also has a lifecycle "Cancel" action.
    const bar = screen.getByRole('region', { name: 'Editing requisition' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Job title')).toBeNull());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('Save issues ONE PATCH with only the changed field + the CAS version, then returns to view', async () => {
    const calls = installFetch((req) => {
      if (req.method === 'PATCH') {
        return { status: 200, body: baseView({ title: 'Changed Title', version: 1 }) };
      }
      return { status: 200, body: baseView() };
    });
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: 'Changed Title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    const body = patch?.body as Record<string, unknown>;
    expect(body['title']).toBe('Changed Title');
    expect(body['version']).toBe(0); // read-then-write CAS token
    // Only the changed field is sent — not a full dump.
    expect(body['city']).toBeUndefined();
    // Returns to view mode.
    await waitFor(() => expect(screen.queryByLabelText('Job title')).toBeNull());
  });

  it('Save validates the required Job title — an empty title blocks the PATCH', async () => {
    const calls = installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Job title'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Job title is required/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
