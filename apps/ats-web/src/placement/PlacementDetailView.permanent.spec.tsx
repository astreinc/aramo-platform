import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlacementDetailView } from './PlacementDetailView';
import type { PermanentPlacementResponse, PermanentPlacementView } from './permanent-placement-types';
import type { PlacementView } from './types';

// Track 7 / T7-P5 §5.1 — the permanent-vs-contract DISCRIMINATION proof. PlacementDetailView reads
// GET permanent ONLY with placement:permanent:read; a NON-NULL permanent aggregate ⇒ render the
// guarantee panel and SUPPRESS the (misleading) contract assignment panels; a NULL response (a
// real absence — contract/legacy placement) ⇒ render the assignment panels. There is NO
// placement_kind added to PlacementView — the discriminator is the permanent read itself. Without
// the read scope, no permanent request is issued at all.

// Assignment panels' internal client calls are mocked so the contract branch renders inertly.
vi.mock('./placement-api', () => ({
  listPlacements: vi.fn().mockResolvedValue({ items: [] }),
  getPlacement: vi.fn(),
  listPlacementEvents: vi.fn(),
  getPlacementAssignment: vi.fn().mockResolvedValue({ assignment: null }),
  getPlacementAssignmentCommercials: vi.fn().mockResolvedValue({ commercials: null }),
  listAssignmentCommercialRevisions: vi.fn().mockResolvedValue({ items: [] }),
  createAssignmentCommercialRevision: vi.fn(),
  cancelAssignmentCommercialRevision: vi.fn(),
  endPlacementAssignment: vi.fn(),
}));

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

// A holder of both the contract-assignment read AND the permanent read, so the branch is decided
// by the permanent RESPONSE, not by a missing scope.
const READ_BOTH = makeSession(['placement:read', 'assignment:read', 'placement:permanent:read']);
const READ_NO_PERMANENT = makeSession(['placement:read', 'assignment:read']);

function placement(): PlacementView {
  return {
    id: 'p1',
    tenant_id: 't1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    state: 'STARTED',
    offered_at: '2026-01-01T00:00:00.000Z',
    proposed_start_date: null,
    offer_expires_at: null,
    client_offer_reference: null,
    offer_terms_summary: null,
    created_at: '2026-01-01T00:00:00.000Z',
  } as PlacementView;
}

function permanentView(): PermanentPlacementView {
  return {
    id: 'pp1',
    tenant_id: 't1',
    placement_process_id: 'p1',
    submittal_id: 's1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    lifecycle_state: 'GUARANTEE_ACTIVE',
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
  };
}

function renderDetail(session: Session, permanentResponse: PermanentPlacementResponse) {
  const getPlacementFn = vi.fn().mockResolvedValue(placement());
  const listEventsFn = vi.fn().mockResolvedValue({ items: [] });
  const getPermanentFn = vi.fn().mockResolvedValue(permanentResponse);
  return {
    getPermanentFn,
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <PlacementDetailView
            placementIdOverride="p1"
            sessionOverride={session}
            getPlacementFn={getPlacementFn}
            listEventsFn={listEventsFn}
            getPermanentFn={getPermanentFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});

describe('PlacementDetailView — permanent-vs-contract discrimination (T7-P5 §5.1)', () => {
  it('a NON-NULL permanent aggregate renders the guarantee panel and SUPPRESSES the assignment panels', async () => {
    renderDetail(READ_BOTH, { permanent: permanentView() });
    expect(await screen.findByTestId('permanent-placement-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('assignment-lifecycle-panel')).toBeNull();
    expect(screen.queryByTestId('assignment-commercial-panel')).toBeNull();
  });

  it('a NULL permanent response renders the contract assignment panels (no guarantee panel)', async () => {
    renderDetail(READ_BOTH, { permanent: null });
    expect(await screen.findByTestId('assignment-lifecycle-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('permanent-placement-panel')).toBeNull();
  });

  it('without placement:permanent:read no permanent request is issued (assignment panels render)', async () => {
    const { getPermanentFn } = renderDetail(READ_NO_PERMANENT, { permanent: permanentView() });
    expect(await screen.findByTestId('assignment-lifecycle-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('placement-detail-loading')).toBeNull());
    expect(getPermanentFn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('permanent-placement-panel')).toBeNull();
  });
});
