import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider } from '../shell/breadcrumb';

import { RequisitionDetailView } from './RequisitionDetailView';

// Requisition Approval sub-workflow (D7) — the named approval affordances render
// in the detail header, gated by (current status × scope), and each drives the
// governed status transition through the PATCH saveField. The gating LOGIC is
// proven exhaustively in approval-affordance.spec.ts; this proves the header
// actually wires the affordances + fires the transition.

function sessionWith(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function reqWith(status: string) {
  return {
    id: 'req-1', tenant_id: 't', site_id: null, title: 'Senior Rust Engineer',
    company_id: 'co-1', contact_id: null, company_department_id: null, status,
    type: 'C2H', is_hot: false, openings: 3, openings_available: 2, capacity_balance: 2,
    city: 'Austin', state: 'TX', external_req_id: null, work_arrangement: 'remote',
    created_at: '2026-05-29T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    recruiter_id: 'usr-rec', owner_id: null, version: 4,
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// Mock the app fetch; capture any PATCH to the requisition so a click can be asserted.
function mockApi(status: string): { patches: Array<{ body: Record<string, unknown> }> } {
  const patches: Array<{ body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v1/requisitions/req-1')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ body });
        return json({ ...reqWith(String(body['status'] ?? status)), version: 5 });
      }
      return json(reqWith(status));
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

describe('RequisitionDetailView — approval affordances (D7)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draft + edit scope → "Submit for approval" renders; no Approve/Reject', async () => {
    mockApi('draft');
    mount('draft', ['requisition:read', 'requisition:edit']);
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('pending_approval + requisition:approve → Approve + Reject render', async () => {
    mockApi('pending_approval');
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });

  it('pending_approval WITHOUT requisition:approve → no Approve/Reject (full editor cannot approve)', async () => {
    mockApi('pending_approval');
    mount('pending_approval', ['requisition:read', 'requisition:edit']);
    // Wait for the header to settle (company link resolves) before asserting absence.
    await screen.findByText('Northwind Robotics');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('clicking Approve PATCHes status → open with the current version', async () => {
    const { patches } = mockApi('pending_approval');
    mount('pending_approval', ['requisition:read', 'requisition:edit', 'requisition:approve']);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toMatchObject({ status: 'open', version: 4 });
  });
});
