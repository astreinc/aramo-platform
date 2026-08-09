import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlacementDetailView } from './PlacementDetailView';
import {
  getPlacement,
  getPlacementAssignment,
  listPlacementEvents,
} from './placement-api';
import type { ContractAssignmentView, PlacementEventView, PlacementView } from './types';

// T4-E / E1-d composition proofs (CHARACTERIZATION — additive product surface).
// The detail container is exercised through the real ./placement-api module
// (mocked at the network seam), so the container→panel composition and the
// single assignment read path are genuinely driven.

vi.mock('./placement-api', () => ({
  getPlacement: vi.fn(),
  listPlacementEvents: vi.fn(),
  getPlacementAssignment: vi.fn(),
  endPlacementAssignment: vi.fn(),
}));

const getPlacementMock = vi.mocked(getPlacement);
const listEventsMock = vi.mocked(listPlacementEvents);
const getAssignmentMock = vi.mocked(getPlacementAssignment);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const READ = makeSession(['placement:read', 'assignment:read']);
const NO_READ = makeSession(['requisition:read']);

function placement(overrides: Partial<PlacementView> = {}): PlacementView {
  return {
    id: 'p1',
    tenant_id: 't1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    state: 'STARTED',
    offered_at: '2026-08-01T00:00:00Z',
    proposed_start_date: null,
    offer_expires_at: null,
    client_offer_reference: 'REF-100',
    offer_terms_summary: null,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function event(): PlacementEventView {
  return {
    id: 'e1',
    tenant_id: 't1',
    placement_process_id: 'p1',
    event_type: 'state_transition',
    event_payload: { from: 'READY_TO_START', to: 'STARTED' },
    reason_code: null,
    reason_label_snapshot: null,
    reason_detail: null,
    created_at: '2026-08-01T00:00:00Z',
  };
}

function assignment(overrides: Partial<ContractAssignmentView> = {}): ContractAssignmentView {
  return {
    id: 'a1',
    placement_process_id: 'p1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    started_at: '2026-08-01T09:30:00.000Z',
    provenance: 'FORWARD',
    lifecycle_state: 'ACTIVE',
    end_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  getPlacementMock.mockReset();
  listEventsMock.mockReset();
  getAssignmentMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail(session: Session) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PlacementDetailView placementIdOverride="p1" sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('PlacementDetailView — placement product composition', () => {
  // Proof G — PlacementCard mounted with the authoritative placement; the
  // composition supplies no onAction, so NO inert transition control renders
  // (FIX_NOW — read-only composition truth), yet placement info stays visible.
  it('G: composes PlacementCard (authoritative state, read-only — no inert transition control)', async () => {
    getPlacementMock.mockResolvedValue(placement({ state: 'READY_TO_START' }));
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({ assignment: assignment() });
    const { container } = renderDetail(READ);
    await screen.findByTestId('placement-detail');
    // Placement information is visible…
    expect(screen.getByTestId('placement-state').textContent).toBe('Ready to start');
    // …but the composition wires no transition-write handler → no dead control.
    expect(container.querySelectorAll('.placement-card__action')).toHaveLength(0);
  });

  // Proof H — PlacementEventTimeline mounted with the placement's events.
  it('H: composes PlacementEventTimeline with the placement event history', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [event()] });
    getAssignmentMock.mockResolvedValue({ assignment: assignment() });
    renderDetail(READ);
    await screen.findByTestId('placement-detail');
    expect(screen.getByTestId('placement-timeline')).toBeInTheDocument();
  });

  // Proof I + K — AssignmentLifecyclePanel mounted on the same detail; ACTIVE rendered.
  it('I/K: composes AssignmentLifecyclePanel and renders the ACTIVE lifecycle', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({ assignment: assignment({ lifecycle_state: 'ACTIVE' }) });
    renderDetail(READ);
    expect(await screen.findByTestId('assignment-lifecycle-panel')).toBeInTheDocument();
    expect((await screen.findByTestId('assignment-lifecycle-state')).textContent).toBe('Active');
  });

  // Proof L — ENDED assignment renders the exact ending reason within the detail.
  it('L: renders an ENDED assignment ending reason in the composed detail', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({
      assignment: assignment({ lifecycle_state: 'ENDED', end_reason: 'CLIENT_ENDED' }),
    });
    renderDetail(READ);
    const reason = await screen.findByTestId('assignment-end-reason');
    expect(reason.textContent).toBe('Client ended');
    expect(reason.getAttribute('data-end-reason')).toBe('CLIENT_ENDED');
  });

  // Proof M — null assignment: parent detail stays loaded; child reaches a
  // terminal empty state; no END; parent not stuck loading.
  it('M: null assignment ⇒ parent detail loaded, child terminal empty, no END, not stuck', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({ assignment: null });
    renderDetail(READ);
    // Parent finishes loading (placement card visible).
    expect(await screen.findByTestId('placement-detail')).toBeInTheDocument();
    expect(screen.getByTestId('placement-state')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('placement-detail-loading')).toBeNull());
    // Child terminal empty; no END; no fabricated lifecycle.
    expect(await screen.findByTestId('assignment-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
    expect(screen.queryByTestId('assignment-lifecycle-state')).toBeNull();
  });

  // Proof E (affordance-integrity sweep) — no control on the composed surface
  // exists without a real implementation behind it. Rendered in the read-only /
  // null case (a state that PRE-FIX would have shown inert PlacementCard
  // transition buttons and where no END path exists): the surface must carry no
  // handler-less <button>, and every <a> must have a real navigation target.
  it('E: the composed detail exposes no inert control (every affordance is backed)', async () => {
    getPlacementMock.mockResolvedValue(placement({ state: 'READY_TO_START' }));
    listEventsMock.mockResolvedValue({ items: [event()] });
    getAssignmentMock.mockResolvedValue({ assignment: null });
    const { container } = renderDetail(READ);
    await screen.findByTestId('placement-detail');
    await screen.findByTestId('assignment-empty');
    // PlacementCard read-only (no onAction) → no transition control.
    expect(container.querySelectorAll('.placement-card__action')).toHaveLength(0);
    // Null assignment → no END control (the only assignment-panel button).
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
    // Sweep: no handler-less <button> anywhere on the composed surface…
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // …and every link is a real navigation target.
    for (const a of Array.from(container.querySelectorAll('a'))) {
      expect(a.getAttribute('href')).toBeTruthy();
    }
  });

  // Proof S — single assignment read path: the child panel owns the assignment
  // read; the container reads only placement + events.
  it('S: the assignment read is owned by the child panel (no duplicate read path)', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({ assignment: assignment() });
    renderDetail(READ);
    await screen.findByTestId('assignment-lifecycle-panel');
    await waitFor(() => expect(getAssignmentMock).toHaveBeenCalledTimes(1));
    expect(getPlacementMock).toHaveBeenCalledTimes(1);
    expect(listEventsMock).toHaveBeenCalledTimes(1);
    expect(getAssignmentMock).toHaveBeenCalledWith('p1');
  });

  // Proof T — no capacity content introduced by the composition.
  it('T: introduces no capacity content in the composed detail', async () => {
    getPlacementMock.mockResolvedValue(placement());
    listEventsMock.mockResolvedValue({ items: [] });
    getAssignmentMock.mockResolvedValue({ assignment: assignment() });
    renderDetail(READ);
    const detail = await screen.findByTestId('placement-detail');
    expect(within(detail).queryByText(/capacity|opening|reserved|balance/i)).toBeNull();
  });

  // Least-visibility — without placement:read the detail surface is absent and
  // no placement read is issued.
  it('least-visibility: without placement:read the detail is absent and no read is issued', () => {
    renderDetail(NO_READ);
    expect(screen.queryByTestId('placement-detail')).toBeNull();
    expect(getPlacementMock).not.toHaveBeenCalled();
    expect(getAssignmentMock).not.toHaveBeenCalled();
  });

  it('renders an error state when the placement cannot be loaded', async () => {
    getPlacementMock.mockRejectedValue(new Error('not visible'));
    listEventsMock.mockResolvedValue({ items: [] });
    renderDetail(READ);
    expect(await screen.findByText(/could not load this placement/i)).toBeInTheDocument();
  });
});
