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

vi.mock('../pipeline/Kanban', () => ({
  Kanban: () => <div data-testid="kanban" />,
}));
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
}));
vi.mock('./ProfileWorkbenchPanel', () => ({
  ProfileWorkbenchPanel: () => <div data-testid="profile-panel" />,
}));

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
    company_id: 'co-1',
    contact_id: null,
    company_department_id: null,
    status: 'active',
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
    job_type: null,
    labor_category: null,
    role_family: null,
    seniority_level: null,
    headcount_reason: null,
    work_arrangement: null,
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
    expect(
      await screen.findByRole('heading', { name: 'Senior Engineer' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByTestId('profile-panel')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView cockpit — per-field affordance', () => {
  it('full editor sees an EDIT affordance on an OPEN field (Title)', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: 'Senior Engineer' });
    expect(
      screen.getByRole('button', { name: /edit title/i }),
    ).toBeInTheDocument();
  });

  it('recruiter (read-only) sees NO edit affordance on OPEN fields', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read']));
    await screen.findByRole('heading', { name: 'Senior Engineer' });
    expect(screen.queryByRole('button', { name: /edit title/i })).toBeNull();
    // The value is still shown (read-only).
    expect(screen.getByTestId('cockpit-field-title')).toHaveTextContent(
      'Senior Engineer',
    );
  });

  it('compensation section is ABSENT when the payload omits comp fields (masking by absence)', async () => {
    installFetch(() => ({ status: 200, body: baseView() }));
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: 'Senior Engineer' });
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
    await screen.findByRole('heading', { name: 'Senior Engineer' });
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
    await screen.findByRole('heading', { name: 'Senior Engineer' });
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
