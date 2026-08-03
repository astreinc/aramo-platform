import {
  fireEvent,
  render as rawRender,
  screen,
  waitFor,
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

// The cockpit (inline-edit sections + workbench) lives in the Details tab
// (Pipeline is the default). Open it before asserting on cockpit fields.
async function openDetails() {
  await screen.findByRole('heading', { name: /Senior Engineer/ });
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
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

describe('RequisitionDetailView cockpit — headline UX reachable', () => {
  it('renders the cockpit (title heading + Identity section) for an entitled user', async () => {
    installFetch((req) => {
      if (req.method === 'GET' && req.url.includes('/v1/requisitions/req-1')) {
        return { status: 200, body: baseView() };
      }
      return { status: 404, body: {} };
    });
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByTestId('profile-panel')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView cockpit — per-field affordance', () => {
  it('full editor sees an EDIT affordance on an OPEN field (Title)', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    expect(
      screen.getByRole('button', { name: /edit title/i }),
    ).toBeInTheDocument();
  });

  it('recruiter (read-only) sees NO edit affordance on OPEN fields', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read']));
    await openDetails();
    expect(screen.queryByRole('button', { name: /edit title/i })).toBeNull();
    // The value is still shown (read-only).
    expect(screen.getByTestId('cockpit-field-title')).toHaveTextContent(
      'Senior Engineer',
    );
  });

  it('compensation section is ABSENT when the payload omits comp fields (masking by absence)', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    expect(screen.queryByText('Compensation')).toBeNull();
    expect(screen.queryByTestId('cockpit-field-pay_rate_amount')).toBeNull();
  });

  it('pay editor sees Compensation with pay fields editable; derived views read-only', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({
        pay_rate_amount: '60.00',
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        margin_amount: '12.00',
      }),
    }));
    mount(makeSession(['requisition:read', 'compensation:edit:pay']));
    await openDetails();
    expect(screen.getByText('Compensation')).toBeInTheDocument();
    // Pay field editable.
    expect(
      screen.getByRole('button', { name: /edit pay rate/i }),
    ).toBeInTheDocument();
    // Derived margin present but NOT editable (DERIVED bucket).
    expect(screen.getByTestId('cockpit-field-margin_amount')).toHaveTextContent(
      '12.00',
    );
    expect(screen.queryByRole('button', { name: /edit margin$/i })).toBeNull();
  });
});

describe('RequisitionDetailView cockpit — backend is truth', () => {
  it('a save the backend rejects (403) surfaces a permission error (FE affordance is cosmetic)', async () => {
    const calls = installFetch((req) => {
      if (req.method === 'PATCH') {
        return { status: 403, body: { error: { code: 'INSUFFICIENT_PERMISSIONS' } } };
      }
      return { status: 200, body: baseView() };
    });
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    fireEvent.click(screen.getByRole('button', { name: /edit title/i }));
    const input = screen.getByLabelText('Title');
    fireEvent.change(input, { target: { value: 'Forced change' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to change this field/i),
      ).toBeInTheDocument(),
    );
    // The PATCH was attempted (backend, not the FE, is the gate).
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
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

  it('the cockpit exposes an editable Onsite days / week field', async () => {
    installFetch(() => ({
      status: 200,
      body: baseView({ work_arrangement: 'hybrid', onsite_days_per_week: 3 }),
    }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await openDetails();
    const field = screen.getByTestId('cockpit-field-onsite_days_per_week');
    expect(field).toBeInTheDocument();
    expect(field).toHaveTextContent('3');
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
