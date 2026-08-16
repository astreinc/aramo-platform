import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentLifecyclePanel } from './AssignmentLifecyclePanel';
import { getPlacementAssignment } from './placement-api';
import type { ContractAssignmentView, ConvertToPermanentResponse } from './types';

// Track 7 / T7-PX — the convert-to-permanent action on the assignment lifecycle panel. Least
// visibility (hide, don't disable): the action requires the EXACT conjunction assignment:end AND
// placement:permanent:transition, and an ACTIVE assignment. On success the panel navigates to the
// NEW permanent placement returned by the command. A converted source renders its end reason.

vi.mock('./placement-api', () => ({
  getPlacementAssignment: vi.fn(),
  endPlacementAssignment: vi.fn(),
  convertAssignmentToPermanent: vi.fn(),
}));
const getMock = vi.mocked(getPlacementAssignment);

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const READ = makeSession(['assignment:read']);
const READ_END = makeSession(['assignment:read', 'assignment:end']);
const READ_CONVERT = makeSession(['assignment:read', 'assignment:end', 'placement:permanent:transition']);

function assignment(overrides: Partial<ContractAssignmentView> = {}): ContractAssignmentView {
  return {
    id: 'a1', placement_process_id: 'p1', submittal_id: 's1', requisition_id: 'r1', talent_record_id: 'tr1',
    started_at: '2026-01-01T00:00:00.000Z', provenance: 'FORWARD', lifecycle_state: 'ACTIVE', end_reason: null, ...overrides,
  };
}

function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>;
}
function renderPanel(session: Session, convertFn?: (id: string) => Promise<ConvertToPermanentResponse>) {
  return render(
    <MemoryRouter initialEntries={['/placements/p1']}>
      <ToastProvider>
        <AssignmentLifecyclePanel
          placementId="p1"
          sessionOverride={session}
          convertToPermanentFn={convertFn}
          effectiveTermsFn={vi.fn().mockResolvedValue({ guarantee_duration_days: 365, remedy_policy: 'REFUND', guarantee_exposure_amount: '50000.00', currency: 'USD' })}
        />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  getMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('AssignmentLifecyclePanel — T7-PX convert action', () => {
  it('read-only actor gets NO convert action', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ);
    await screen.findByTestId('assignment-detail');
    expect(screen.queryByTestId('convert-to-permanent-action')).toBeNull();
  });

  it('assignment:end WITHOUT placement:permanent:transition gets NO convert action (exact conjunction)', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ_END);
    await screen.findByTestId('assignment-detail');
    expect(screen.queryByTestId('assignment-end-action')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-to-permanent-action')).toBeNull();
  });

  it('ACTIVE + both scopes ⇒ the convert action is available', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    renderPanel(READ_CONVERT);
    expect(await screen.findByTestId('convert-to-permanent-action')).toBeInTheDocument();
  });

  it('an ENDED assignment offers NO convert action', async () => {
    getMock.mockResolvedValue({ assignment: assignment({ lifecycle_state: 'ENDED', end_reason: 'COMPLETED' }) });
    renderPanel(READ_CONVERT);
    await screen.findByTestId('assignment-end-reason');
    expect(screen.queryByTestId('convert-to-permanent-action')).toBeNull();
  });

  it('renders the converted-to-permanent end reason on a converted source assignment', async () => {
    getMock.mockResolvedValue({ assignment: assignment({ lifecycle_state: 'ENDED', end_reason: 'CONVERTED_TO_PERMANENT' }) });
    renderPanel(READ_CONVERT);
    const reason = await screen.findByTestId('assignment-end-reason');
    expect(reason.textContent).toBe('Converted to permanent');
    expect(reason.getAttribute('data-end-reason')).toBe('CONVERTED_TO_PERMANENT');
  });

  it('on successful conversion navigates to the NEW permanent placement id', async () => {
    getMock.mockResolvedValue({ assignment: assignment() });
    const convertFn = vi.fn().mockResolvedValue({
      replayed: false, source_placement_process_id: 'p1', source_contract_assignment_id: 'a1',
      target_placement_process_id: 'target-1', target_permanent_placement_id: 'perm-1',
    });
    renderPanel(READ_CONVERT, convertFn);
    fireEvent.click(await screen.findByTestId('convert-to-permanent-action'));
    fireEvent.click(await screen.findByTestId('convert-to-permanent-confirm'));
    await waitFor(() => expect(convertFn).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/placements/target-1'));
  });
});
