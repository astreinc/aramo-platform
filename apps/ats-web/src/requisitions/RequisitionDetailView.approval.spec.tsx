import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider } from '../shell/breadcrumb';

import { RequisitionDetailView } from './RequisitionDetailView';

// L1-E — the named lifecycle actions render in the detail header, gated by
// (current status × scope × submitter-context), each driving the governed
// status-changing PATCH through saveField. The gating LOGIC is proven
// exhaustively in approval-affordance.spec.ts + lifecycle-action-drift.spec.ts;
// this proves the header WIRES the actions, fires the transition, suppresses the
// submitter's own Approve (SoD line), and surfaces typed refusals via the toast.

const SELF = 'u1'; // sessionWith sub

function sessionWith(scopes: string[]): Session {
  return { sub: SELF, consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function reqWith(status: string, submitterId: string | null = null) {
  return {
    id: 'req-1', tenant_id: 't', site_id: null, title: 'Senior Rust Engineer',
    company_id: 'co-1', contact_id: null, company_department_id: null, status,
    type: 'C2H', is_hot: false, openings: 3, openings_available: 2, capacity_balance: 2,
    city: 'Austin', state: 'TX', external_req_id: null, work_arrangement: 'remote',
    created_at: '2026-05-29T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    recruiter_id: 'usr-rec', owner_id: null, version: 4,
    pending_approval_submitter_id: submitterId,
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface MockOpts {
  readonly submitterId?: string | null;
  // When set, a PATCH responds with this error (typed-refusal proofs).
  readonly patchError?: { status: number; code: string; details?: Record<string, unknown> };
}

// Mock the app fetch; capture any PATCH to the requisition so a click can be asserted.
function mockApi(status: string, opts: MockOpts = {}): { patches: Array<{ body: Record<string, unknown> }> } {
  const patches: Array<{ body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v1/requisitions/req-1')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ body });
        if (opts.patchError !== undefined) {
          return json(
            { error: { code: opts.patchError.code, details: opts.patchError.details } },
            opts.patchError.status,
          );
        }
        return json({ ...reqWith(String(body['status'] ?? status), opts.submitterId ?? null), version: 5 });
      }
      return json(reqWith(status, opts.submitterId ?? null));
    }
    if (url.includes('/v1/pipelines')) return json({ items: [] });
    if (url.includes('/v1/companies/co-1')) return json({ id: 'co-1', name: 'Northwind Robotics' });
    if (url.includes('/v1/tenant/users')) return json({ items: [] });
    return json({ items: [] });
  });
  return { patches };
}

function mount(status: string, scopes: string[]) {
  return render(
    <ToastProvider>
      <BreadcrumbProvider>
        <MemoryRouter initialEntries={['/requisitions/req-1']}>
          <Routes>
            <Route
              path="/requisitions/:reqId"
              element={<RequisitionDetailView sessionOverride={sessionWith(scopes)} />}
            />
          </Routes>
        </MemoryRouter>
      </BreadcrumbProvider>
    </ToastProvider>,
  );
}

describe('RequisitionDetailView — named lifecycle actions (L1-E)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draft + edit scope → "Submit for approval" renders; no Approve/Reject', async () => {
    mockApi('draft');
    mount('draft', ['requisition:read', 'requisition:edit']);
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('open + edit scope → Close submittals + Put on hold + Close + Cancel (status is NOT an editable select)', async () => {
    mockApi('open');
    mount('open', ['requisition:read', 'requisition:edit']);
    expect(await screen.findByRole('button', { name: 'Close submittals' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Put on hold' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // Reopen is illegal from open.
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('RBAC — no edit-status scope → none of Close / Hold / Cancel / Close-submittals', async () => {
    mockApi('open');
    mount('open', ['requisition:read']);
    await screen.findByText('Northwind Robotics');
    for (const name of ['Close', 'Put on hold', 'Cancel', 'Close submittals']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('RequisitionDetailView — approval + segregation of duties (L1-E)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pending_approval + requisition:approve (a DIFFERENT approver) → Approve + Reject render', async () => {
    mockApi('pending_approval', { submitterId: 'someone-else' });
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });

  it('pending_approval WITHOUT requisition:approve → no Approve/Reject (full editor cannot approve)', async () => {
    mockApi('pending_approval', { submitterId: 'someone-else' });
    mount('pending_approval', ['requisition:read', 'requisition:edit']);
    await screen.findByText('Northwind Robotics');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('SoD — the SUBMITTER sees NO actionable Approve + the SoD line; Reject stays', async () => {
    mockApi('pending_approval', { submitterId: SELF });
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    expect(
      await screen.findByText('You submitted this requisition for approval. Another approver is required.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});

describe('RequisitionDetailView — lifecycle actions PATCH {status,version} (L1-E)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clicking Approve PATCHes status → open with the current version', async () => {
    const { patches } = mockApi('pending_approval', { submitterId: 'someone-else' });
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toMatchObject({ status: 'open', version: 4 });
  });

  it('clicking Close PATCHes status → closed with the current version', async () => {
    const { patches } = mockApi('open');
    mount('open', ['requisition:read', 'requisition:edit']);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toMatchObject({ status: 'closed', version: 4 });
  });

  it('clicking Close submittals PATCHes status → submittals_closed with the current version', async () => {
    const { patches } = mockApi('open');
    mount('open', ['requisition:read', 'requisition:edit']);
    fireEvent.click(await screen.findByRole('button', { name: 'Close submittals' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toMatchObject({ status: 'submittals_closed', version: 4 });
  });
});

describe('RequisitionDetailView — lifecycle action typed errors (L1-E)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('409 version conflict → specific reload copy (NOT the generic fallback)', async () => {
    mockApi('open', { patchError: { status: 409, code: 'REQUISITION_VERSION_CONFLICT' } });
    mount('open', ['requisition:read', 'requisition:edit']);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(
      await screen.findByText(/This requisition changed since you loaded it\. Reload and try the action again\./),
    ).toBeTruthy();
    expect(screen.queryByText(/could not be completed/)).toBeNull();
  });

  it('422 status-gated → specific illegal-transition copy', async () => {
    mockApi('open', { patchError: { status: 422, code: 'REQUISITION_STATUS_GATED' } });
    mount('open', ['requisition:read', 'requisition:edit']);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(
      await screen.findByText(/That action is not available from the requisition.s current status\./),
    ).toBeTruthy();
  });

  it('403 self-approval → the SoD line copy', async () => {
    mockApi('pending_approval', {
      submitterId: 'someone-else',
      patchError: { status: 403, code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'requisition_self_approval_forbidden' } },
    });
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText('You submitted this requisition for approval. Another approver is required.'),
    ).toBeTruthy();
  });

  it('403 POLICY_DENIED → specific policy-denied copy', async () => {
    mockApi('open', { patchError: { status: 403, code: 'POLICY_DENIED' } });
    mount('open', ['requisition:read', 'requisition:edit']);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/That action was not permitted for this requisition\./)).toBeTruthy();
  });
});
