import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { PermanentPlacementGuaranteePanel } from './PermanentPlacementGuaranteePanel';
import type { PermanentPlacementRemedyView, PermanentPlacementState, PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 — least-visibility gating proofs for the guarantee panel (hide, don't disable).
// The panel is only mounted by PlacementDetailView when GET permanent is non-null and the actor
// holds placement:permanent:read; here we prove the ACTION gating on top of that:
//   satisfy / falloff  → placement:permanent:transition, and ONLY while GUARANTEE_ACTIVE;
//   complete remedy    → placement:remedy:resolve, and ONLY in a remedy-due state with a remedy.
// A read-only actor sees the snapshot but NO action; a transition actor never gets the remedy
// action; a resolve actor never gets the lifecycle actions. Rendering asserts the calendar dates
// and per-currency exposure surface.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const READ = makeSession(['placement:permanent:read']);
const READ_TRANSITION = makeSession(['placement:permanent:read', 'placement:permanent:transition']);
const READ_RESOLVE = makeSession(['placement:permanent:read', 'placement:remedy:resolve']);
const READ_ALL = makeSession([
  'placement:permanent:read',
  'placement:permanent:transition',
  'placement:remedy:resolve',
]);

function remedy(overrides: Partial<PermanentPlacementRemedyView> = {}): PermanentPlacementRemedyView {
  return {
    remedy_type: 'REPLACEMENT',
    calculated_amount: null,
    currency: null,
    remaining_days: null,
    falloff_effective_date: '2026-06-01',
    due_at: '2026-09-01T00:00:00.000Z',
    completed_at: null,
    completed_by: null,
    completion_reference: null,
    replacement_placement_process_id: null,
    ...overrides,
  };
}

function permanent(
  state: PermanentPlacementState,
  overrides: Partial<PermanentPlacementView> = {},
): PermanentPlacementView {
  return {
    id: 'pp1',
    tenant_id: 't1',
    placement_process_id: 'p1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    lifecycle_state: state,
    guarantee_start_date: '2026-01-01T00:00:00.000Z',
    guarantee_duration_days: 365,
    guarantee_end_date: '2027-01-01T00:00:00.000Z',
    remedy_policy: 'REPLACEMENT',
    guarantee_exposure_amount: '10000.00',
    guarantee_exposure_currency: 'USD',
    terms_source: 'MANUAL',
    recorded_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    falloff_effective_date: null,
    falloff_reason: null,
    falloff_recorded_by: null,
    falloff_recorded_at: null,
    remedy: null,
    ...overrides,
  };
}

function renderPanel(session: Session, view: PermanentPlacementView) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PermanentPlacementGuaranteePanel placementId="p1" permanent={view} onRefresh={vi.fn()} sessionOverride={session} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('PermanentPlacementGuaranteePanel — least-visibility action gating', () => {
  it('renders the guarantee snapshot (calendar dates + per-currency exposure) with a read-only actor', () => {
    renderPanel(READ, permanent('GUARANTEE_ACTIVE'));
    expect(screen.getByTestId('permanent-placement-panel')).toBeInTheDocument();
    expect(screen.getByTestId('guarantee-detail')).toBeInTheDocument();
    // @db.Date rendered as a calendar date (no timezone day-shift), not an instant.
    expect(screen.getByTestId('guarantee-start').textContent).toBe('2026-01-01');
    expect(screen.getByTestId('guarantee-end').textContent).toBe('2027-01-01');
    // Money is shown WITH its currency, never combined/converted.
    expect(screen.getByTestId('guarantee-exposure').textContent).toContain('USD');
  });

  it('a read-only actor gets NO lifecycle or remedy actions', () => {
    renderPanel(READ, permanent('GUARANTEE_ACTIVE'));
    expect(screen.queryByTestId('falloff-record-action')).toBeNull();
    expect(screen.queryByTestId('guarantee-satisfy-action')).toBeNull();
    expect(screen.queryByTestId('remedy-complete-action')).toBeNull();
  });

  it('GUARANTEE_ACTIVE + transition ⇒ satisfy + falloff actions, but NO remedy action', () => {
    renderPanel(READ_TRANSITION, permanent('GUARANTEE_ACTIVE'));
    expect(screen.getByTestId('falloff-record-action')).toBeInTheDocument();
    expect(screen.getByTestId('guarantee-satisfy-action')).toBeInTheDocument();
    expect(screen.queryByTestId('remedy-complete-action')).toBeNull();
  });

  it('a remedy-due state + resolve + a remedy ⇒ the remedy action ONLY (no lifecycle actions)', () => {
    renderPanel(READ_RESOLVE, permanent('REPLACEMENT_DUE', {
      falloff_effective_date: '2026-06-01',
      falloff_reason: 'CLIENT_TERMINATED_PERFORMANCE',
      remedy: remedy(),
    }));
    expect(screen.getByTestId('remedy-complete-action')).toBeInTheDocument();
    expect(screen.queryByTestId('falloff-record-action')).toBeNull();
    expect(screen.queryByTestId('guarantee-satisfy-action')).toBeNull();
  });

  it('transition scope does NOT unlock the remedy action in a remedy-due state', () => {
    renderPanel(READ_TRANSITION, permanent('REPLACEMENT_DUE', {
      falloff_effective_date: '2026-06-01',
      falloff_reason: 'CLIENT_TERMINATED_PERFORMANCE',
      remedy: remedy(),
    }));
    expect(screen.queryByTestId('remedy-complete-action')).toBeNull();
    // Not active → no lifecycle actions either.
    expect(screen.queryByTestId('guarantee-satisfy-action')).toBeNull();
  });

  it('a terminal state (GUARANTEE_SATISFIED) offers no actions even with all scopes', () => {
    renderPanel(READ_ALL, permanent('GUARANTEE_SATISFIED', { guarantee_end_date: '2026-04-01T00:00:00.000Z' }));
    expect(screen.queryByTestId('falloff-record-action')).toBeNull();
    expect(screen.queryByTestId('guarantee-satisfy-action')).toBeNull();
    expect(screen.queryByTestId('remedy-complete-action')).toBeNull();
  });

  it('a remedy-due state with a NULL remedy offers no remedy action (guarded)', () => {
    renderPanel(READ_ALL, permanent('REPLACEMENT_DUE', { falloff_effective_date: '2026-06-01', remedy: null }));
    expect(screen.queryByTestId('remedy-complete-action')).toBeNull();
  });
});
