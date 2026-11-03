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

// CONTACTS-1 HM-3 / SD-5 — the requisition's hiring manager (contact_id) is
// editable on the detail page through the company-filtered contact picker
// (requisition:edit), and a deleted hiring manager still shows as
// "Name (Deleted)" via GET /v1/contacts/:id?include_deleted=true. Helpers
// mirror RequisitionDetailView.cockpit.spec.tsx; heavy child surfaces are
// stubbed.

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
vi.mock('./RequirementSkills', () => ({
  RequirementSkills: () => <div data-testid="skills-panel" />,
}));

// The cockpit (inline-edit sections + workbench) lives in the Details tab (the
// requisition record form, formerly labelled "Overview" — the internal TabId is
// still 'overview'). Workspace is now the default tab, so select Details
// explicitly before asserting.
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

function contact(id: string, first: string, last: string, extra: Record<string, unknown> = {}) {
  return {
    id, first_name: first, last_name: last, title: null, company_id: 'co-1',
    deleted_at: null, deleted_by_id: null, contact_kind: null, ...extra,
  };
}

const LIVE = [contact('ct-1', 'Ada', 'Lovelace', { title: 'CTO' }), contact('ct-2', 'Alan', 'Turing')];

function route(
  reqExtra: Record<string, unknown>,
  onPatch?: (req: MockedRequest) => { status: number; body: unknown },
) {
  return (req: MockedRequest): { status: number; body: unknown } => {
    if (req.method === 'PATCH' && onPatch !== undefined) return onPatch(req);
    const single = req.url.match(/\/v1\/contacts\/([^?/]+)/);
    if (single !== null) {
      if (single[1] === 'ct-gone') {
        return {
          status: 200,
          body: contact('ct-gone', 'Grace', 'Hopper', { deleted_at: '2026-11-01T00:00:00Z' }),
        };
      }
      return { status: 200, body: LIVE.find((c) => c.id === single[1]) ?? {} };
    }
    if (req.url.includes('/v1/contacts?')) return { status: 200, body: { items: LIVE } };
    return { status: 200, body: baseView(reqExtra) };
  };
}

describe('RequisitionDetailView — hiring manager (CONTACTS-1)', () => {
  it('a deleted hiring manager reads "Name (Deleted)", resolved with include_deleted', async () => {
    const calls = installFetch(route({ contact_id: 'ct-gone' }));
    mount(makeSession(['requisition:read']));
    await openDetails();
    expect(await screen.findByText('Grace Hopper (Deleted)')).toBeInTheDocument();
    const get = calls.find((c) => c.url.includes('/v1/contacts/ct-gone'));
    expect(get?.url).toContain('include_deleted=true');
  });

  it('edit mode offers the company-filtered picker; choosing a contact PATCHes contact_id', async () => {
    const calls = installFetch(
      route({ contact_id: 'ct-1' }, (req) => ({
        status: 200,
        body: baseView({ contact_id: (req.body as Record<string, unknown>)['contact_id'], version: 1 }),
      })),
    );
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const picker = await screen.findByRole('combobox', { name: 'Hiring manager' });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/v1/contacts?') && c.url.includes('company_id=co-1'))).toBe(true),
    );
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: /Alan Turing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(body['contact_id']).toBe('ct-2');
    expect(body['version']).toBe(0);
    // the new hiring manager's name is re-resolved
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/v1/contacts/ct-2'))).toBe(true),
    );
  });

  it('"No hiring manager" clears it (contact_id: null)', async () => {
    const calls = installFetch(
      route({ contact_id: 'ct-1' }, () => ({ status: 200, body: baseView({ version: 1 }) })),
    );
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Hiring manager' }));
    fireEvent.click(await screen.findByRole('option', { name: /No hiring manager/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(body['contact_id']).toBeNull();
  });

  it('a CONTACT_DELETED refusal is shown legibly', async () => {
    installFetch(
      route({ contact_id: null }, () => ({
        status: 422,
        body: { error: { code: 'CONTACT_DELETED', message: 'x', details: { field: 'contact_id', contact_id: 'ct-2' } } },
      })),
    );
    mount(makeSession(['requisition:read', 'requisition:edit']));
    await screen.findByRole('heading', { name: /Senior Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Hiring manager' }));
    fireEvent.click(await screen.findByRole('option', { name: /Alan Turing/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/has been deleted/)).toBeInTheDocument();
  });

  it('without requisition:edit there is no Edit entry (so no picker)', async () => {
    installFetch(route({ contact_id: 'ct-1' }));
    mount(makeSession(['requisition:read']));
    await openDetails();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Hiring manager' })).toBeNull();
  });
});
