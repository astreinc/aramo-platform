import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentCommercialPanel } from './AssignmentCommercialPanel';
import { getPlacementAssignmentCommercials } from './placement-api';
import type { AssignmentCommercialView } from './types';

// T5-P3 proofs. Per the build directive §6, these are CHARACTERIZATION of new
// additive UI behaviour: the placement-detail commercial panel is greenfield — there
// is no pre-existing behaviour to flip, and a new UI test failing only because the
// component does not yet exist is NOT a behaviour boundary (component non-existence is
// not a D-1 boundary). Reporting these as CHARACTERIZATION is the correct outcome; the
// panel→placement-api binding is genuinely driven (the real ./placement-api module is
// mocked only at the network seam). No RED was manufactured by weakening any code.

vi.mock('./placement-api', () => ({
  getPlacementAssignmentCommercials: vi.fn(),
}));

const getMock = vi.mocked(getPlacementAssignmentCommercials);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

// The dedicated financial scope, plus the negative controls that must NOT satisfy it.
const COMMERCIALS_READ = makeSession(['assignment:commercials:read']);
const ASSIGNMENT_READ_ONLY = makeSession(['assignment:read']);
const PLACEMENT_READ_ONLY = makeSession(['placement:read']);
const REQUISITION_READ_ONLY = makeSession(['requisition:read']);
const COMMERCIALS_WRITE_ONLY = makeSession(['assignment:commercials:write']);

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
    effective_from: '2026-08-01T09:30:00.000Z',
    effective_to: null,
    change_reason: null,
    recorded_by: 'user-1',
    created_at: '2026-08-01T09:30:00.000Z',
    ...overrides,
  };
}

function renderPanel(session: Session) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AssignmentCommercialPanel placementId="p1" sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // The panel never issues a real request (./placement-api is mocked). Only
  // useSession touches apiClient; stub fetch so no real network is attempted.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  getMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssignmentCommercialPanel — T5-P3 placement-detail commercial UI', () => {
  // P1 — authorized + data → panel visible, exact server values rendered verbatim.
  it('P1: authorized read renders the exact projection values (pay/bill/spread/margin/markup)', async () => {
    getMock.mockResolvedValue({ commercials: commercials() });
    renderPanel(COMMERCIALS_READ);

    expect(await screen.findByTestId('commercials-detail')).toBeTruthy();
    expect(screen.getByTestId('commercials-pay-rate').textContent).toBe('80.00 USD/hr');
    expect(screen.getByTestId('commercials-bill-rate').textContent).toBe('120.00 USD/hr');
    expect(screen.getByTestId('commercials-spread').textContent).toBe('40.00 USD/hr');
    expect(screen.getByTestId('commercials-margin').textContent).toBe('33.33%');
    expect(screen.getByTestId('commercials-markup').textContent).toBe('50.00%');
    expect(getMock).toHaveBeenCalledWith('p1');
  });

  // P2 — authorized + { commercials: null } → coherent empty state, NOT an error.
  it('P2: authorized + no commercial version → coherent empty state, not an error', async () => {
    getMock.mockResolvedValue({ commercials: null });
    renderPanel(COMMERCIALS_READ);

    expect(await screen.findByTestId('commercials-empty')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('commercials-detail')).toBeNull();
  });

  // P3 — least-visibility: a scope that is NOT assignment:commercials:read renders
  // NOTHING and never issues the read. assignment:read / placement:read /
  // requisition:read / commercials-write-only must not satisfy it.
  it.each([
    ['assignment:read only', ASSIGNMENT_READ_ONLY],
    ['placement:read only', PLACEMENT_READ_ONLY],
    ['requisition:read only', REQUISITION_READ_ONLY],
    ['commercials:write only (write does not imply read)', COMMERCIALS_WRITE_ONLY],
  ])('P3: %s → panel absent AND no request issued', async (_label, session) => {
    renderPanel(session);
    // A brief settle: the panel must neither render nor fetch.
    await Promise.resolve();
    expect(screen.queryByTestId('assignment-commercial-panel')).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  // P4 — zero denominator: null margin/markup render as an em-dash (never NaN/Infinity).
  it('P4: null margin_percent / markup_percent render as an em-dash', async () => {
    getMock.mockResolvedValue({
      commercials: commercials({ margin_percent: null, markup_percent: null }),
    });
    renderPanel(COMMERCIALS_READ);

    expect((await screen.findByTestId('commercials-margin')).textContent).toBe('—');
    expect(screen.getByTestId('commercials-markup').textContent).toBe('—');
  });

  // P5 — effective dates render; a null effective_to (current/open version) shows "Current".
  it('P5: effective_from renders; effective_to null → "Current"', async () => {
    getMock.mockResolvedValue({ commercials: commercials({ effective_to: null }) });
    renderPanel(COMMERCIALS_READ);

    expect(await screen.findByTestId('commercials-effective-from')).toBeTruthy();
    expect(screen.getByTestId('commercials-effective-to').textContent).toBe('Current');
  });

  // P6 — server integrity failure (e.g. the T5-P2 overlap INTERNAL_ERROR) → fail-closed
  // error UI, NO commercial values leaked, and never a client-side "pick one".
  it('P6: a server failure fails closed — error UI, no values leaked', async () => {
    getMock.mockRejectedValue(new Error('INTERNAL_ERROR'));
    renderPanel(COMMERCIALS_READ);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('commercials-detail')).toBeNull();
    expect(screen.queryByTestId('commercials-pay-rate')).toBeNull();
    expect(screen.queryByTestId('commercials-bill-rate')).toBeNull();
  });

  // P7 — loading state per house convention (text line + data-testid, not a skeleton).
  it('P7: shows the loading line while the read is in flight', async () => {
    let resolve!: (v: { commercials: AssignmentCommercialView | null }) => void;
    getMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderPanel(COMMERCIALS_READ);

    expect(screen.getByTestId('commercials-loading')).toBeTruthy();
    resolve({ commercials: commercials() });
    await waitFor(() => expect(screen.getByTestId('commercials-detail')).toBeTruthy());
  });
});
