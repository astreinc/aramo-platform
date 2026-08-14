import { ApiError, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { RequisitionIngestionView } from './RequisitionIngestionView';
import type { ImportBatchView } from './types';

// T8-P3 — provider-neutral requisition-ingestion MONITORING surface (read-only).
// RBAC-gated by requisition:import:read; consumes only GET /v1/requisition-imports
// and GET /:id. No mutation, no POST, no per-record drill-down, no deep-links, no
// secrets (directive §9/§24). Injected fn seams + sessionOverride (house pattern).

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const READ = makeSession(['requisition:import:read']);
const NO_READ = makeSession(['requisition:read']);

function batch(over: Partial<ImportBatchView> = {}): ImportBatchView {
  return {
    id: 'b1',
    tenant_id: 't1',
    site_id: null,
    imported_by_id: 'u9',
    target_entity: 'requisition',
    source_filename: 'fieldglass',
    row_count: 3,
    success_count: 2,
    failure_count: 1,
    status: 'partially_committed',
    created_at: '2026-08-01T00:00:00Z',
    committed_at: '2026-08-01T00:01:00Z',
    reverted_at: null,
    ...over,
  };
}

function renderView(opts: {
  session?: Session;
  listFn?: () => Promise<readonly ImportBatchView[]>;
  getFn?: (id: string) => Promise<ImportBatchView>;
}) {
  const listFn = opts.listFn ?? vi.fn(async () => [] as readonly ImportBatchView[]);
  const getFn = opts.getFn ?? vi.fn(async () => batch());
  render(
    <MemoryRouter>
      <RequisitionIngestionView sessionOverride={opts.session} listFn={listFn} getFn={getFn} />
    </MemoryRouter>,
  );
  return { listFn, getFn };
}

describe('RequisitionIngestionView — RBAC (§24.1-3)', () => {
  it('1. no requisition:import:read → surface absent + list fn NOT called', () => {
    const listFn = vi.fn(async () => [batch()]);
    renderView({ session: NO_READ, listFn });
    expect(screen.queryByTestId('requisition-ingestion')).toBeNull();
    expect(listFn).not.toHaveBeenCalled();
  });
  it('1b. unauthenticated (no session) → surface absent + no fetch', () => {
    const listFn = vi.fn(async () => [batch()]);
    renderView({ session: undefined, listFn });
    expect(screen.queryByTestId('requisition-ingestion')).toBeNull();
    expect(listFn).not.toHaveBeenCalled();
  });
  it('2. with requisition:import:read → surface renders + list GET occurs', async () => {
    const listFn = vi.fn(async () => [batch()]);
    renderView({ session: READ, listFn });
    expect(screen.getByTestId('requisition-ingestion')).toBeTruthy();
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));
  });
  it('3/13/14/16/17. read-only — no mutation/POST/replay/revert/drill-down/secret controls', async () => {
    renderView({ session: READ, listFn: async () => [batch({ failure_count: 2 })] });
    await screen.findByTestId('ingestion-batch-row-b1');
    const root = screen.getByTestId('requisition-ingestion');
    // no create/run/submit/update/upsert/replay/retry/revert/import affordance
    for (const el of root.querySelectorAll('button, a')) {
      expect(el.textContent ?? '').not.toMatch(/run|submit|create|new import|import now|update|upsert|reconcile|overwrite|replay|retry|revert|sync/i);
    }
    // no per-record failure drill-down toggle
    expect(root.querySelector('[data-testid^="import-failures-toggle"]')).toBeNull();
    expect(screen.queryByText(/view failures/i)).toBeNull();
    // no secret/credential inputs
    expect(root.querySelector('input[type="password"]')).toBeNull();
    for (const inp of root.querySelectorAll('input, textarea')) {
      expect((inp.getAttribute('name') ?? '') + (inp.getAttribute('aria-label') ?? '')).not.toMatch(/secret|token|password|credential|api.?key/i);
    }
  });
});

describe('RequisitionIngestionView — list states (§24.4-7)', () => {
  it('4. loading state', () => {
    renderView({ session: READ, listFn: () => new Promise(() => {}) });
    expect(screen.getByTestId('ingestion-loading')).toBeTruthy();
  });
  it('5. empty list state', async () => {
    renderView({ session: READ, listFn: async () => [] });
    expect(await screen.findByTestId('ingestion-empty')).toBeTruthy();
  });
  it('6. populated list renders canonical status + counts', async () => {
    renderView({ session: READ, listFn: async () => [batch({ status: 'partially_committed' })] });
    const row = await screen.findByTestId('ingestion-batch-row-b1');
    expect(within(row).getByText(/partially committed/i)).toBeTruthy(); // canonical label, not 'partial'
    expect(row.textContent).toMatch(/3/); // row_count
    expect(row.textContent).toMatch(/2/); // success_count
  });
  it('7. list API error → product-safe alert', async () => {
    renderView({ session: READ, listFn: async () => { throw new ApiError('boom', 500); } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/stack|at Object|\bDB\b|sql/i);
  });
});

describe('RequisitionIngestionView — detail (§24.8-10)', () => {
  it('8/9. selecting a batch calls detail GET + renders supported fields only', async () => {
    const getFn = vi.fn(async (id: string) => batch({ id, status: 'committed', success_count: 3, failure_count: 0 }));
    renderView({ session: READ, listFn: async () => [batch()], getFn });
    fireEvent.click(await screen.findByTestId('ingestion-batch-row-b1'));
    await waitFor(() => expect(getFn).toHaveBeenCalledWith('b1'));
    const detail = await screen.findByTestId('ingestion-batch-detail');
    // does not display internal tenant/user identifiers
    expect(detail.textContent ?? '').not.toContain('t1');
    expect(detail.textContent ?? '').not.toContain('u9');
  });
  it('10. detail 404/error degrades safely', async () => {
    const getFn = vi.fn(async () => { throw new ApiError('nope', 404); });
    renderView({ session: READ, listFn: async () => [batch()], getFn });
    fireEvent.click(await screen.findByTestId('ingestion-batch-row-b1'));
    expect(await screen.findByTestId('ingestion-batch-detail')).toBeTruthy();
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });
});

describe('RequisitionIngestionView — provider neutrality + exclusions (§24.11-15)', () => {
  it('11. an unknown canonical source_system/source label remains renderable', async () => {
    renderView({ session: READ, listFn: async () => [batch({ source_filename: 'brand_new_vms_2027' })] });
    const row = await screen.findByTestId('ingestion-batch-row-b1');
    expect(row.textContent).toMatch(/brand.new.vms.2027/i);
  });
  it('12. no provider-specific closed dropdown / select', async () => {
    renderView({ session: READ, listFn: async () => [batch()] });
    await screen.findByTestId('ingestion-batch-row-b1');
    expect(screen.getByTestId('requisition-ingestion').querySelector('select')).toBeNull();
  });
  it('15. no created-requisition deep-link', async () => {
    renderView({ session: READ, listFn: async () => [batch({ status: 'committed', failure_count: 0 })] });
    await screen.findByTestId('ingestion-batch-row-b1');
    const anchors = screen.getByTestId('requisition-ingestion').querySelectorAll('a[href]');
    for (const a of anchors) expect(a.getAttribute('href') ?? '').not.toMatch(/\/requisitions\//);
  });
});

describe('RequisitionIngestionView — accessibility (§24.18-20)', () => {
  it('18. accessible page heading + list semantics', async () => {
    renderView({ session: READ, listFn: async () => [batch()] });
    expect(screen.getByRole('heading', { name: /requisition ingestion/i })).toBeTruthy();
    await screen.findByTestId('ingestion-batch-row-b1');
  });
  it('19. batch rows are keyboard-actionable buttons', async () => {
    renderView({ session: READ, listFn: async () => [batch()], getFn: async () => batch() });
    const row = await screen.findByTestId('ingestion-batch-row-b1');
    expect(row.tagName === 'BUTTON' || row.getAttribute('role') === 'button').toBe(true);
  });
  it('20. load error is announced (role=alert)', async () => {
    renderView({ session: READ, listFn: async () => { throw new ApiError('x', 500); } });
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });
});
