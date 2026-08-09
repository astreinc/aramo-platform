import { type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlacementBoardView } from './PlacementBoardView';
import type { PlacementView } from './types';

// T4-E / E1-d composition proofs (CHARACTERIZATION — additive discovery surface).
// The board is exercised via injected list fn (the house fn-injection seam);
// least-visibility is proven by asserting no read is issued without placement:read.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const READ = makeSession(['placement:read']);
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

let listFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  listFn = vi.fn();
});

function renderBoard(session: Session) {
  return render(
    <MemoryRouter>
      <PlacementBoardView sessionOverride={session} listPlacementsFn={listFn} />
    </MemoryRouter>,
  );
}

describe('PlacementBoardView — placement discovery surface', () => {
  // Proof B/C — reachable, loading terminates.
  it('B/C: renders the board and terminates loading', async () => {
    listFn.mockResolvedValue({ items: [placement()] });
    renderBoard(READ);
    expect(await screen.findByTestId('placement-board')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('placement-board-loading')).toBeNull());
  });

  // Proof E — real API placements rendered, deterministic newest-first order.
  it('E: renders placements identified by their own human fields, newest offered first', async () => {
    listFn.mockResolvedValue({
      items: [
        placement({ id: 'old', client_offer_reference: 'REF-OLD', offered_at: '2026-01-01T00:00:00Z' }),
        placement({ id: 'new', client_offer_reference: 'REF-NEW', offered_at: '2026-09-01T00:00:00Z' }),
      ],
    });
    renderBoard(READ);
    await screen.findByTestId('placement-board');
    expect(screen.getByTestId('placement-row-new')).toHaveTextContent('REF-NEW');
    expect(screen.getByTestId('placement-row-old')).toHaveTextContent('REF-OLD');
    // Deterministic order: newest offered first.
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('data-testid', 'placement-row-new');
  });

  // Proof F — a row navigates to the correct placement detail id.
  it('F: each row links to /placements/:id', async () => {
    listFn.mockResolvedValue({ items: [placement({ id: 'abc' })] });
    renderBoard(READ);
    const link = await screen.findByTestId('placement-row-abc');
    expect(link).toHaveAttribute('href', '/placements/abc');
  });

  // Proof D — coherent terminal empty state; no fabricated placements.
  it('D: renders a coherent empty state for zero placements', async () => {
    listFn.mockResolvedValue({ items: [] });
    renderBoard(READ);
    expect(await screen.findByText('No placements visible to you yet.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('placement-board-loading')).toBeNull());
  });

  it('renders an error state on a failed read', async () => {
    listFn.mockRejectedValue(new Error('boom'));
    renderBoard(READ);
    expect(await screen.findByText(/could not load placements/i)).toBeInTheDocument();
  });

  // Least-visibility — no placement:read ⇒ board absent AND no read issued.
  it('J(board): without placement:read the board is absent and no read is issued', () => {
    renderBoard(NO_READ);
    expect(screen.queryByTestId('placement-board')).toBeNull();
    expect(listFn).not.toHaveBeenCalled();
  });

  // Proof T — no capacity content on the discovery surface.
  it('T: introduces no capacity content', async () => {
    listFn.mockResolvedValue({ items: [placement()] });
    renderBoard(READ);
    const board = await screen.findByTestId('placement-board');
    expect(within(board).queryByText(/capacity|opening|reserved|balance/i)).toBeNull();
  });
});
