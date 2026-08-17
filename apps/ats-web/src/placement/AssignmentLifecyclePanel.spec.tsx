import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatInstant } from '../format/date';

import { AssignmentLifecyclePanel } from './AssignmentLifecyclePanel';
import { endPlacementAssignment, getPlacementAssignment } from './placement-api';
import type { ContractAssignmentEndReason, ContractAssignmentView } from './types';

// T4-E proofs. These are CHARACTERIZATION of new additive UI behavior (the
// assignment-lifecycle panel + safe END control are greenfield; there is no
// pre-existing behavior to flip), NOT chronological RED-first — a new UI test
// failing only because the component does not yet exist is not a behaviour
// boundary. The panel is exercised through the normal frontend API layer: the
// real ./placement-api module is mocked at the network seam, so the
// panel→placement-api binding is genuinely driven.

vi.mock('./placement-api', () => ({
  getPlacementAssignment: vi.fn(),
  endPlacementAssignment: vi.fn(),
}));

const getMock = vi.mocked(getPlacementAssignment);
const endMock = vi.mocked(endPlacementAssignment);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

// assignment:read alone; assignment:read + assignment:end; and a placement:*
// holder WITHOUT assignment:end — placement:* must NOT satisfy assignment:end.
const READ = makeSession(['assignment:read']);
const READ_END = makeSession(['assignment:read', 'assignment:end']);
const READ_PLACEMENT = makeSession([
  'assignment:read',
  'placement:activate',
  'placement:terminate',
  'placement:transition',
]);
const NO_ASSIGNMENT_SCOPE = makeSession(['placement:read', 'placement:activate']);

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

function ended(reason: ContractAssignmentEndReason): ContractAssignmentView {
  return assignment({ lifecycle_state: 'ENDED', end_reason: reason });
}

function renderPanel(session: Session) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AssignmentLifecyclePanel placementId="p1" sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // The panel never issues a real request (./placement-api is mocked). Only
  // useSession touches apiClient; stub fetch so no real network is attempted.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  getMock.mockReset();
  endMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssignmentLifecyclePanel — Track 4 assignment lifecycle UI', () => {
  // Proof A — ACTIVE assignment renders through the frontend API layer.
  it('A: renders an ACTIVE assignment (lifecycle state + started_at) via getPlacementAssignment', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ);

    const state = await screen.findByTestId('assignment-lifecycle-state');
    expect(state.textContent).toBe('Active');
    expect(state.getAttribute('data-lifecycle-state')).toBe('ACTIVE');

    const startedAt = screen.getByTestId('assignment-started-at');
    expect(startedAt.getAttribute('datetime')).toBe('2026-08-01T09:30:00.000Z');
    // T10-B4/F-026 — started_at is an INSTANT: the shared formatInstant renders
    // it with the time component (was a bare date-only toLocaleDateString).
    expect(startedAt.textContent).toBe(formatInstant('2026-08-01T09:30:00.000Z'));
    expect(screen.getByTestId('assignment-provenance').textContent).toBe('Forward');

    expect(getMock).toHaveBeenCalledWith('p1');
  });

  // Proof B — ENDED assignment renders the ending reason; the authoritative
  // discriminator is preserved (label + raw value), never collapsed.
  it('B: renders an ENDED assignment with its ending reason label and raw discriminator', async () => {
    getMock.mockResolvedValue({ assignment: ended('CLIENT_ENDED') });
    renderPanel(READ);

    const reason = await screen.findByTestId('assignment-end-reason');
    expect(reason.textContent).toBe('Client ended');
    expect(reason.getAttribute('data-end-reason')).toBe('CLIENT_ENDED');
    expect(screen.getByTestId('assignment-lifecycle-state').textContent).toBe('Ended');
  });

  // Proof B (continued) — all three reasons map to distinct labels + raw values.
  it('B2: preserves the full ending taxonomy distinction (no collapse)', async () => {
    const cases: ReadonlyArray<[ContractAssignmentEndReason, string]> = [
      ['COMPLETED', 'Completed'],
      ['WORKER_ENDED', 'Worker ended'],
      ['CLIENT_ENDED', 'Client ended'],
    ];
    for (const [raw, label] of cases) {
      getMock.mockResolvedValue({ assignment: ended(raw) });
      const { unmount } = renderPanel(READ);
      const reason = await screen.findByTestId('assignment-end-reason');
      expect(reason.textContent).toBe(label);
      expect(reason.getAttribute('data-end-reason')).toBe(raw);
      unmount();
    }
    // Three distinct labels for three distinct raw values.
    expect(new Set(cases.map(([, l]) => l)).size).toBe(3);
  });

  // Proof C — no assignment: a coherent, observable TERMINAL empty state.
  it('C: renders a coherent empty state for assignment === null (no error, no END, not stuck loading)', async () => {
    getMock.mockResolvedValue({ assignment: null });
    renderPanel(READ);

    // Empty content becomes visible…
    const empty = await screen.findByTestId('assignment-empty');
    expect(empty).toBeInTheDocument();
    // …the loading indicator disappears (not indefinitely loading)…
    await waitFor(() => expect(screen.queryByTestId('assignment-loading')).toBeNull());
    // …no error state…
    expect(screen.queryByRole('alert')).toBeNull();
    // …no END control…
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
    // …and NO fabricated lifecycle values.
    expect(screen.queryByTestId('assignment-lifecycle-state')).toBeNull();
    expect(screen.queryByTestId('assignment-detail')).toBeNull();
  });

  // Proof D — lifecycle panel visibility follows assignment:read.
  it('D: renders the panel WITH assignment:read', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ);
    expect(await screen.findByTestId('assignment-lifecycle-panel')).toBeInTheDocument();
  });

  it('D2: hides the panel and never reads WITHOUT assignment:read (least-visibility)', () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(NO_ASSIGNMENT_SCOPE);
    expect(screen.queryByTestId('assignment-lifecycle-panel')).toBeNull();
    // Never fetch what the actor cannot see.
    expect(getMock).not.toHaveBeenCalled();
  });

  // Proof E — END authority: read-only actor never receives the END action.
  it('E: an assignment:read-only actor does NOT get the END control on an ACTIVE assignment', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ);
    await screen.findByTestId('assignment-detail');
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
  });

  it('E2: placement:* authority does NOT satisfy assignment:end (no END control)', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ_PLACEMENT);
    await screen.findByTestId('assignment-detail');
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
  });

  // Proof F — ACTIVE + assignment:end ⇒ END control available.
  it('F: ACTIVE assignment + assignment:end ⇒ END control is available', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ_END);
    expect(await screen.findByTestId('assignment-end-action')).toBeInTheDocument();
  });

  // Proof G — ENDED + assignment:end ⇒ END control absent.
  it('G: ENDED assignment + assignment:end ⇒ END control is ABSENT', async () => {
    getMock.mockResolvedValue({ assignment: ended('COMPLETED') });
    renderPanel(READ_END);
    await screen.findByTestId('assignment-end-reason');
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
  });

  it('G2: unknown lifecycle (null) + assignment:end ⇒ END control is ABSENT (ACTIVE-only)', async () => {
    getMock.mockResolvedValue({ assignment: assignment({ lifecycle_state: null }) });
    renderPanel(READ_END);
    await screen.findByTestId('assignment-detail');
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
    expect(screen.getByTestId('assignment-lifecycle-state').textContent).toBe('—');
  });

  // Proof H — successful END: correct mutation + reason, authoritative re-read,
  // server ENDED truth rendered (never locally manufactured).
  it('H: END posts the chosen reason, re-reads authoritative state, and renders the server ENDED truth', async () => {
    getMock
      .mockResolvedValueOnce({ assignment: assignment() })
      .mockResolvedValueOnce({ assignment: ended('WORKER_ENDED') });
    endMock.mockResolvedValue({ ok: true });
    renderPanel(READ_END);

    fireEvent.click(await screen.findByTestId('assignment-end-action'));
    // Choose a NON-default reason to prove the exact discriminator is sent.
    fireEvent.click(screen.getByLabelText('Worker ended'));
    fireEvent.click(screen.getByTestId('assignment-end-confirm'));

    await waitFor(() => expect(endMock).toHaveBeenCalledWith('p1', 'WORKER_ENDED'));

    // Authoritative re-read (initial + refresh) — 2 reads.
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

    // Server truth rendered: ENDED + Worker ended; END control gone.
    const reason = await screen.findByTestId('assignment-end-reason');
    expect(reason.textContent).toBe('Worker ended');
    expect(reason.getAttribute('data-end-reason')).toBe('WORKER_ENDED');
    expect(screen.getByTestId('assignment-lifecycle-state').textContent).toBe('Ended');
    expect(screen.queryByTestId('assignment-end-action')).toBeNull();
  });

  it('H2: a backend refusal surfaces via the error UX and does not manufacture an ENDED state', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    endMock.mockRejectedValue(new Error('refused'));
    renderPanel(READ_END);

    fireEvent.click(await screen.findByTestId('assignment-end-action'));
    fireEvent.click(screen.getByTestId('assignment-end-confirm'));

    // Error shown inside the dialog; no ENDED truth manufactured.
    expect(await screen.findByText(/could not end the assignment/i)).toBeInTheDocument();
    expect(screen.getByTestId('assignment-lifecycle-state').textContent).toBe('Active');
    // Only the initial read happened — no false refresh to ENDED.
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  // Proof I — capacity is strictly out of scope on this surface.
  it('I: the panel renders NO capacity field and derives no capacity', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ_END);
    const panel = await screen.findByTestId('assignment-lifecycle-panel');
    expect(within(panel).queryByText(/capacity|opening|reserved|balance/i)).toBeNull();
    expect(panel.textContent ?? '').not.toMatch(/capacity|opening|reserved|balance/i);
  });
});
