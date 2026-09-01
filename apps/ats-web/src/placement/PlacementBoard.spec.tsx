import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementCard } from './PlacementCard';
import { PlacementEventTimeline } from './PlacementEventTimeline';
import type { PlacementEventView, PlacementView } from './types';

const RECRUITER = ['placement:read', 'placement:create', 'placement:transition'];
const MANAGER = [...RECRUITER, 'placement:activate', 'placement:terminate'];

function placement(overrides: Partial<PlacementView> = {}): PlacementView {
  return {
    id: 'p1',
    tenant_id: 't1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    state: 'READY_TO_START',
    offered_at: '2026-08-01T00:00:00Z',
    proposed_start_date: null,
    offer_expires_at: null,
    client_offer_reference: null,
    offer_terms_summary: null,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('PlacementCard — placement state + action affordances (§10)', () => {
  it('renders the authoritative placement state label and NO reason evidence', () => {
    const { container } = render(<PlacementCard placement={placement({ state: 'FELL_THROUGH' })} scopes={RECRUITER} />);
    expect(screen.getByTestId('placement-state').textContent).toBe('Fell through');
    // A card must never carry reason evidence, in the DOM or as an attribute.
    expect(screen.queryByTestId('placement-reason')).toBeNull();
    expect(container.querySelector('[data-testid="placement-reason-detail"]')).toBeNull();
  });

  it('renders the authoritative placement state', () => {
    // Legacy-Pipeline-Canonicalization — there is no Pipeline representation to
    // reconcile against; the card shows the placement state directly.
    render(<PlacementCard placement={placement({ state: 'STARTED' })} scopes={MANAGER} />);
    expect(screen.getByTestId('placement-state').textContent).toBe('Started');
    expect(screen.queryByTestId('placement-mismatch')).toBeNull();
  });

  it('a recruiter card never offers an activate or terminate action (§10 / Proof 8)', () => {
    // READY_TO_START → STARTED is activate-class; the terminal edges are
    // terminate-class. A recruiter (with a real action handler) must see neither.
    const { container } = render(
      <PlacementCard placement={placement({ state: 'READY_TO_START' })} scopes={RECRUITER} onAction={vi.fn()} />,
    );
    const classes = Array.from(container.querySelectorAll('.placement-card__action')).map(
      (b) => b.getAttribute('data-authority-class'),
    );
    expect(classes).not.toContain('activate');
    expect(classes).not.toContain('terminate');
  });

  it('a manager card DOES offer the activate action from READY_TO_START (Proof C — onAction supplied)', () => {
    const { container } = render(
      <PlacementCard placement={placement({ state: 'READY_TO_START' })} scopes={MANAGER} onAction={vi.fn()} />,
    );
    const classes = Array.from(container.querySelectorAll('.placement-card__action')).map(
      (b) => b.getAttribute('data-authority-class'),
    );
    expect(classes).toContain('activate');
  });

  // FIX_NOW (Option B) — no inert transition affordances. A card mounted WITHOUT
  // an onAction handler (the composition does not wire the transition-write seam)
  // shows the placement information but NO transition control.
  it('A/B: without onAction, placement info renders but NO transition control is shown', () => {
    const { container } = render(
      <PlacementCard placement={placement({ state: 'READY_TO_START' })} scopes={MANAGER} />,
    );
    // Placement information stays visible…
    expect(screen.getByTestId('placement-state').textContent).toBe('Ready to start');
    // …and there is no dead/inert transition affordance.
    expect(container.querySelectorAll('.placement-card__action')).toHaveLength(0);
    expect(container.querySelector('.placement-card__actions')).toBeNull();
  });

  it('D: a STARTED card exposes no transition action even with onAction + full scopes', () => {
    const { container } = render(
      <PlacementCard placement={placement({ state: 'STARTED' })} scopes={MANAGER} onAction={vi.fn()} />,
    );
    expect(screen.getByTestId('placement-state').textContent).toBe('Started');
    expect(container.querySelectorAll('.placement-card__action')).toHaveLength(0);
  });
});

describe('PlacementEventTimeline — reason on the authorized detail surface (§10)', () => {
  function ev(overrides: Partial<PlacementEventView> = {}): PlacementEventView {
    return {
      id: 'e1',
      tenant_id: 't1',
      placement_process_id: 'p1',
      event_type: 'state_transition',
      event_payload: { from: 'PRE_START', to: 'READY_TO_START' },
      reason_code: null,
      reason_label_snapshot: null,
      reason_detail: null,
      created_at: '2026-08-01T00:00:00Z',
      ...overrides,
    };
  }

  it('renders the canonical reason label + detail for a governed event', () => {
    render(
      <PlacementEventTimeline
        events={[
          ev({
            id: 'e2',
            event_payload: { from: 'PRE_START', to: 'FELL_THROUGH' },
            reason_code: 'other',
            reason_label_snapshot: 'Other',
            reason_detail: 'talent took another role',
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('placement-reason-label').textContent).toBe('Other');
    expect(screen.getByTestId('placement-reason-detail').textContent).toBe('talent took another role');
  });

  it('a legacy / non-governed event shows NO reason (null preserved, never fabricated)', () => {
    render(<PlacementEventTimeline events={[ev()]} />);
    expect(screen.getByTestId('placement-timeline-event')).toBeInTheDocument();
    expect(screen.queryByTestId('placement-reason')).toBeNull();
  });

  it('renders an empty state when there are no events', () => {
    render(<PlacementEventTimeline events={[]} />);
    expect(screen.getByTestId('placement-timeline-empty')).toBeInTheDocument();
  });
});
