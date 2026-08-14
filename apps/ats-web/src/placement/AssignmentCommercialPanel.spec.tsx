import { ApiError, ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentCommercialPanel } from './AssignmentCommercialPanel';
import {
  cancelAssignmentCommercialRevision,
  createAssignmentCommercialRevision,
  getPlacementAssignment,
  getPlacementAssignmentCommercials,
  listAssignmentCommercialRevisions,
} from './placement-api';
import type { AssignmentCommercialView, ContractAssignmentView } from './types';

// Track 6 / T6-B4 — CHARACTERIZATION of the commercial-lifecycle UI (greenfield additive
// behaviour; component non-existence is not a D-1 boundary — directive §24). The panel↔
// placement-api binding is genuinely driven; ./placement-api is mocked only at the network
// seam. Covers the §24 matrix + the DateTime/Compensation amendment (§2 exact predicate,
// §4/§7 Effective-now-only) + the ENDED-State amendment (§3/§4 final-window / zero-version).

vi.mock('./placement-api', () => ({
  getPlacementAssignment: vi.fn(),
  getPlacementAssignmentCommercials: vi.fn(),
  listAssignmentCommercialRevisions: vi.fn(),
  createAssignmentCommercialRevision: vi.fn(),
  cancelAssignmentCommercialRevision: vi.fn(),
}));

const getAssignment = vi.mocked(getPlacementAssignment);
const getCommercials = vi.mocked(getPlacementAssignmentCommercials);
const listRevisions = vi.mocked(listAssignmentCommercialRevisions);
const createRevision = vi.mocked(createAssignmentCommercialRevision);
const cancelRevision = vi.mocked(cancelAssignmentCommercialRevision);

const NOW = Date.parse('2026-08-01T00:00:00.000Z');

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

// Scope bundles (exact strings — no wildcard). The mutation predicate (amendment §2) needs
// read + write + view:pay + (view:bill OR view:revenue) + ACTIVE. assignment:read is needed
// only for the lifecycle read (the mock returns it regardless of scope).
const READ_ONLY = makeSession(['assignment:commercials:read', 'assignment:read']);
const MUTATE_BILL = makeSession([
  'assignment:commercials:read',
  'assignment:commercials:write',
  'compensation:view:pay',
  'compensation:view:bill',
  'assignment:read',
]);
const MUTATE_REVENUE = makeSession([
  'assignment:commercials:read',
  'assignment:commercials:write',
  'compensation:view:pay',
  'compensation:view:revenue',
  'assignment:read',
]);
const WRITE_NO_PAY = makeSession([
  'assignment:commercials:read',
  'assignment:commercials:write',
  'compensation:view:bill',
  'assignment:read',
]);
const WRITE_NO_BILL = makeSession([
  'assignment:commercials:read',
  'assignment:commercials:write',
  'compensation:view:pay',
  'assignment:read',
]);

function commercials(overrides: Partial<AssignmentCommercialView> = {}): AssignmentCommercialView {
  return {
    contract_assignment_id: 'ca1',
    assignment_rate_version_id: 'rv1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    pay_rate_amount: '80.00',
    bill_rate_amount: '120.00',
    currency: 'USD',
    rate_period: 'HOURLY',
    spread_amount: '40.00',
    margin_percent: '33.33',
    markup_percent: '50.00',
    effective_from: '2026-01-01T09:30:00.000Z',
    effective_to: null,
    change_reason: null,
    recorded_by: 'user-1',
    created_at: '2026-01-01T09:30:00.000Z',
    ...overrides,
  };
}

const ACTIVE: ContractAssignmentView = {
  id: 'a1',
  placement_process_id: 'p1',
  submittal_id: 's1',
  requisition_id: 'r1',
  talent_record_id: 'tr1',
  started_at: '2026-01-01T09:30:00.000Z',
  provenance: 'FORWARD',
  lifecycle_state: 'ACTIVE',
  end_reason: null,
};
const ENDED: ContractAssignmentView = { ...ACTIVE, lifecycle_state: 'ENDED', end_reason: 'COMPLETED' };

function renderPanel(session: Session) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AssignmentCommercialPanel placementId="p1" sessionOverride={session} nowMs={NOW} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  getAssignment.mockReset().mockResolvedValue({ assignment: ACTIVE });
  getCommercials.mockReset().mockResolvedValue({ commercials: commercials() });
  listRevisions.mockReset().mockResolvedValue({ items: [commercials()] });
  createRevision.mockReset().mockResolvedValue({ commercials: commercials() });
  cancelRevision.mockReset().mockResolvedValue({ items: [commercials()] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssignmentCommercialPanel — read visibility (§5/§24)', () => {
  it.each([
    ['assignment:read only', makeSession(['assignment:read'])],
    ['placement:read only', makeSession(['placement:read'])],
    ['commercials:write only (write does not imply read)', makeSession(['assignment:commercials:write'])],
  ])('no commercials:read (%s) → panel absent AND no fetch', async (_l, session) => {
    renderPanel(session);
    await Promise.resolve();
    expect(screen.queryByTestId('assignment-commercial-panel')).toBeNull();
    expect(getCommercials).not.toHaveBeenCalled();
    expect(listRevisions).not.toHaveBeenCalled();
    expect(getAssignment).not.toHaveBeenCalled();
  });

  it('read-only → current terms + timeline render, NO create or cancel controls', async () => {
    listRevisions.mockResolvedValue({ items: [commercials()] });
    renderPanel(READ_ONLY);
    expect(await screen.findByTestId('commercials-detail')).toBeTruthy();
    expect(screen.getByTestId('commercial-timeline')).toBeTruthy();
    expect(screen.queryByTestId('commercial-revision-create-action')).toBeNull();
    expect(screen.queryByTestId('commercial-revision-cancel-action')).toBeNull();
  });

  it('renders exact current values verbatim', async () => {
    renderPanel(READ_ONLY);
    expect((await screen.findByTestId('commercials-pay-rate')).textContent).toBe('80.00 USD/hr');
    expect(screen.getByTestId('commercials-bill-rate').textContent).toBe('120.00 USD/hr');
    expect(screen.getByTestId('commercials-margin').textContent).toBe('33.33%');
  });
});

describe('AssignmentCommercialPanel — mutation predicate (§6 / amendment §2)', () => {
  it('read+write+view:pay+view:bill+ACTIVE → create action present', async () => {
    renderPanel(MUTATE_BILL);
    expect(await screen.findByTestId('commercial-revision-create-action')).toBeTruthy();
  });

  it('bill visibility via compensation:view:revenue also satisfies the predicate', async () => {
    renderPanel(MUTATE_REVENUE);
    expect(await screen.findByTestId('commercial-revision-create-action')).toBeTruthy();
  });

  it('write WITHOUT compensation:view:pay → no mutation controls (masked write actor)', async () => {
    renderPanel(WRITE_NO_PAY);
    expect(await screen.findByTestId('commercials-detail')).toBeTruthy();
    expect(screen.queryByTestId('commercial-revision-create-action')).toBeNull();
  });

  it('write WITHOUT bill/revenue visibility → no mutation controls', async () => {
    renderPanel(WRITE_NO_BILL);
    expect(await screen.findByTestId('commercials-detail')).toBeTruthy();
    expect(screen.queryByTestId('commercial-revision-create-action')).toBeNull();
  });

  it('ACTIVE required — an ENDED assignment shows no create action even for a full-scope actor', async () => {
    getAssignment.mockResolvedValue({ assignment: ENDED });
    listRevisions.mockResolvedValue({ items: [commercials({ effective_to: '2026-02-01T00:00:00.000Z' })] });
    renderPanel(MUTATE_BILL);
    expect(await screen.findByTestId('commercials-ended-state')).toBeTruthy();
    expect(screen.queryByTestId('commercial-revision-create-action')).toBeNull();
  });
});

describe('AssignmentCommercialPanel — compensation masking (§7)', () => {
  it('omitted pay/bill render a non-leaking masked indicator, never "undefined"', async () => {
    getCommercials.mockResolvedValue({
      commercials: commercials({ pay_rate_amount: undefined, bill_rate_amount: undefined, margin_percent: undefined }),
    });
    renderPanel(READ_ONLY);
    const pay = await screen.findByTestId('commercials-pay-rate');
    expect(pay.textContent).toBe('—');
    expect(pay.textContent).not.toContain('undefined');
    expect(within(pay).getByText('—')).toHaveAttribute('data-masked', 'true');
    expect(screen.getByTestId('commercials-bill-rate').textContent).toBe('—');
    expect(screen.getByTestId('commercials-margin').textContent).toBe('—');
    // spread is never masked.
    expect(screen.getByTestId('commercials-spread').textContent).toBe('40.00 USD/hr');
  });
});

describe('AssignmentCommercialPanel — timeline classification + cancel eligibility (§9/§12)', () => {
  const hist = commercials({ assignment_rate_version_id: 'h', effective_from: '2020-01-01T00:00:00.000Z', effective_to: '2024-01-01T00:00:00.000Z' });
  const current = commercials({ assignment_rate_version_id: 'c', effective_from: '2024-01-01T00:00:00.000Z', effective_to: '2030-01-01T00:00:00.000Z' });
  const scheduled = commercials({ assignment_rate_version_id: 'f', effective_from: '2030-01-01T00:00:00.000Z', effective_to: null });

  it('classifies Current / Scheduled / History against now', async () => {
    listRevisions.mockResolvedValue({ items: [scheduled, current, hist] });
    renderPanel(READ_ONLY);
    await screen.findByTestId('commercial-timeline');
    const rows = screen.getAllByTestId('commercial-revision-row');
    const byId = Object.fromEntries(rows.map((r) => [r.getAttribute('data-revision-id'), r.getAttribute('data-status')]));
    expect(byId['c']).toBe('current');
    expect(byId['f']).toBe('scheduled');
    expect(byId['h']).toBe('history');
  });

  it('cancel action appears ONLY on the future open-tail row and only when canMutate', async () => {
    listRevisions.mockResolvedValue({ items: [scheduled, current, hist] });
    renderPanel(MUTATE_BILL);
    await screen.findByTestId('commercial-timeline');
    const rows = screen.getAllByTestId('commercial-revision-row');
    const scheduledRow = rows.find((r) => r.getAttribute('data-revision-id') === 'f')!;
    const currentRow = rows.find((r) => r.getAttribute('data-revision-id') === 'c')!;
    expect(within(scheduledRow).getByTestId('commercial-revision-cancel-action')).toBeTruthy();
    expect(within(currentRow).queryByTestId('commercial-revision-cancel-action')).toBeNull();
  });

  it('read-only actor sees no cancel action even on the future open tail', async () => {
    listRevisions.mockResolvedValue({ items: [scheduled, current] });
    renderPanel(READ_ONLY);
    await screen.findByTestId('commercial-timeline');
    expect(screen.queryByTestId('commercial-revision-cancel-action')).toBeNull();
  });
});

describe('AssignmentCommercialPanel — create flow (§10/§11 + amendment §4/§7/§8)', () => {
  it('the create dialog has NO effective_from date input (Effective-now only)', async () => {
    renderPanel(MUTATE_BILL);
    fireEvent.click(await screen.findByTestId('commercial-revision-create-action'));
    await screen.findByTestId('commercial-revision-create-confirm');
    expect(screen.queryByTestId('commercial-revision-effective-from-input')).toBeNull();
    // no native date input anywhere in the dialog
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it('validation blocks an empty submit; the create fn is not called', async () => {
    renderPanel(MUTATE_BILL);
    fireEvent.click(await screen.findByTestId('commercial-revision-create-action'));
    fireEvent.click(await screen.findByTestId('commercial-revision-create-confirm'));
    await waitFor(() => expect(screen.getByText('A change reason is required.')).toBeTruthy());
    expect(createRevision).not.toHaveBeenCalled();
  });

  it('a valid create OMITS effective_from, toasts, refreshes server truth, and closes', async () => {
    renderPanel(MUTATE_BILL);
    fireEvent.click(await screen.findByTestId('commercial-revision-create-action'));
    fireEvent.change(await screen.findByTestId('commercial-revision-pay-input'), { target: { value: '90.00' } });
    fireEvent.change(screen.getByTestId('commercial-revision-bill-input'), { target: { value: '150.00' } });
    fireEvent.change(screen.getByTestId('commercial-revision-reason-input'), { target: { value: 'rate bump' } });
    getCommercials.mockClear();
    listRevisions.mockClear();
    fireEvent.click(screen.getByTestId('commercial-revision-create-confirm'));
    await waitFor(() => expect(createRevision).toHaveBeenCalledTimes(1));
    const [, body] = createRevision.mock.calls[0];
    expect(body).toEqual({ pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', change_reason: 'rate bump' });
    expect('effective_from' in (body as Record<string, unknown>)).toBe(false);
    // server-truth refresh after create.
    await waitFor(() => expect(getCommercials).toHaveBeenCalled());
    expect(listRevisions).toHaveBeenCalled();
  });

  it('a 409 conflict shows controlled inline copy and refreshes (no optimistic insert)', async () => {
    createRevision.mockRejectedValue(
      new ApiError(409, 'conflict', 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', { reason: 'duplicate_effective_from' }),
    );
    renderPanel(MUTATE_BILL);
    fireEvent.click(await screen.findByTestId('commercial-revision-create-action'));
    fireEvent.change(await screen.findByTestId('commercial-revision-pay-input'), { target: { value: '90.00' } });
    fireEvent.change(screen.getByTestId('commercial-revision-bill-input'), { target: { value: '150.00' } });
    fireEvent.change(screen.getByTestId('commercial-revision-reason-input'), { target: { value: 'x' } });
    getCommercials.mockClear();
    fireEvent.click(screen.getByTestId('commercial-revision-create-confirm'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('refreshed');
    await waitFor(() => expect(getCommercials).toHaveBeenCalled()); // refreshed
  });
});

describe('AssignmentCommercialPanel — cancel flow (§12/§13)', () => {
  const current = commercials({ assignment_rate_version_id: 'c', effective_from: '2024-01-01T00:00:00.000Z', effective_to: '2030-01-01T00:00:00.000Z' });
  const scheduled = commercials({ assignment_rate_version_id: 'f', effective_from: '2030-01-01T00:00:00.000Z', effective_to: null });

  it('cancelling the future open tail sends the reason and refreshes', async () => {
    listRevisions.mockResolvedValue({ items: [scheduled, current] });
    renderPanel(MUTATE_BILL);
    await screen.findByTestId('commercial-timeline');
    fireEvent.click(screen.getByTestId('commercial-revision-cancel-action'));
    fireEvent.click(await screen.findByLabelText('Client request'));
    listRevisions.mockClear();
    fireEvent.click(screen.getByTestId('commercial-revision-cancel-confirm'));
    await waitFor(() => expect(cancelRevision).toHaveBeenCalledWith('p1', 'f', { cancellation_reason_code: 'CLIENT_REQUEST' }));
    await waitFor(() => expect(listRevisions).toHaveBeenCalled()); // refreshed
  });
});

describe('AssignmentCommercialPanel — ENDED state (§18 + ENDED-State amendment §3/§4/§7)', () => {
  it('ENDED with a surviving final version shows its effective_to as the commercial end instant', async () => {
    getAssignment.mockResolvedValue({ assignment: ENDED });
    const endIso = '2026-06-01T15:00:00.000Z';
    listRevisions.mockResolvedValue({
      items: [
        commercials({ assignment_rate_version_id: 'last', effective_from: '2026-03-01T00:00:00.000Z', effective_to: endIso }),
        commercials({ assignment_rate_version_id: 'first', effective_from: '2026-01-01T00:00:00.000Z', effective_to: '2026-03-01T00:00:00.000Z' }),
      ],
    });
    renderPanel(MUTATE_BILL);
    const endedAt = await screen.findByTestId('commercials-ended-at');
    expect(endedAt.getAttribute('datetime')).toBe(endIso);
    expect(endedAt.textContent).toBe(new Date(endIso).toLocaleString()); // instant-safe formatter
    expect(screen.queryByTestId('commercial-revision-create-action')).toBeNull();
    expect(screen.queryByTestId('commercial-revision-cancel-action')).toBeNull();
  });

  it('ENDED with zero surviving non-cancelled revisions renders ENDED WITHOUT a timestamp', async () => {
    getAssignment.mockResolvedValue({ assignment: ENDED });
    listRevisions.mockResolvedValue({ items: [] });
    getCommercials.mockResolvedValue({ commercials: null });
    renderPanel(MUTATE_BILL);
    expect(await screen.findByTestId('commercials-ended-no-timestamp')).toBeTruthy();
    expect(screen.queryByTestId('commercials-ended-at')).toBeNull();
  });
});

describe('AssignmentCommercialPanel — instant display (DateTime amendment §6)', () => {
  it('effective_from renders via the instant-safe local formatter with the raw ISO on <time>', async () => {
    const iso = '2026-01-01T09:30:00.000Z';
    getCommercials.mockResolvedValue({ commercials: commercials({ effective_from: iso }) });
    renderPanel(READ_ONLY);
    const el = await screen.findByTestId('commercials-effective-from');
    expect(el.getAttribute('datetime')).toBe(iso);
    expect(el.textContent).toBe(new Date(iso).toLocaleString());
  });
});
