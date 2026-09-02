import { type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { PreStartWorkspaceView } from './PreStartWorkspaceView';
import type { PreStartPlacementRequirements, PreStartRequirementView } from './types';

// L5-P7 — the onboarding workspace CONTAINER: loads governed requirements and dispatches
// each affordance to its write client. Uses the house fn/session injection seams.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
function reqView(over: Partial<PreStartRequirementView> = {}): PreStartRequirementView {
  return {
    id: over.id ?? 'req-1',
    placement_process_id: 'plc-1',
    requirement_type: 'BACKGROUND_CHECK',
    label: over.label ?? 'Background check',
    blocking: over.blocking ?? true,
    satisfaction_policy: over.satisfaction_policy ?? 'SELF_ATTEST',
    status: over.status ?? 'PENDING',
    owner_role: null,
    completed_at: null,
    completed_by: null,
    evidence_reference: null,
    evidence_restricted: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}
function reqs(over: Partial<PreStartPlacementRequirements> = {}): PreStartPlacementRequirements {
  return {
    materialized: over.materialized ?? true,
    ready: over.ready ?? false,
    blocking_unresolved_count: over.blocking_unresolved_count ?? 1,
    requirements: over.requirements ?? [reqView()],
  };
}

function renderView(props: Parameters<typeof PreStartWorkspaceView>[0]) {
  return render(
    <MemoryRouter>
      <PreStartWorkspaceView placementIdOverride="plc-1" {...props} />
    </MemoryRouter>,
  );
}

describe('PreStartWorkspaceView (container)', () => {
  it('loads requirements and dispatches Satisfy to the status write client + refreshes', async () => {
    const getRequirementsFn = vi.fn().mockResolvedValue(reqs());
    const statusMoveFn = vi.fn().mockResolvedValue(reqView({ status: 'SATISFIED' }));
    renderView({
      sessionOverride: makeSession(['pre_start_requirement:read', 'pre_start_requirement:act']),
      getRequirementsFn,
      statusMoveFn,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Satisfy' }));
    await waitFor(() => expect(statusMoveFn).toHaveBeenCalledTimes(1));
    expect(statusMoveFn.mock.calls[0]).toEqual(['req-1', { to: 'SATISFIED' }]);
    // initial load + post-action refresh.
    await waitFor(() => expect(getRequirementsFn).toHaveBeenCalledTimes(2));
  });

  it('Mark-ready dispatches to the readiness write client', async () => {
    const markReadyFn = vi.fn().mockResolvedValue({ id: 'plc-1', state: 'READY_TO_START' });
    renderView({
      sessionOverride: makeSession(['pre_start_requirement:read', 'pre_start_requirement:act']),
      getRequirementsFn: vi.fn().mockResolvedValue(reqs({ ready: true, blocking_unresolved_count: 0, requirements: [reqView({ status: 'SATISFIED' })] })),
      markReadyFn,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark ready to start' }));
    await waitFor(() => expect(markReadyFn).toHaveBeenCalledWith('plc-1'));
  });

  it('Waive opens a justification form and dispatches with authority + justification', async () => {
    const waiveFn = vi.fn().mockResolvedValue(reqView({ status: 'WAIVED' }));
    renderView({
      sessionOverride: makeSession(['pre_start_requirement:read', 'pre_start_requirement:waive_blocking']),
      getRequirementsFn: vi.fn().mockResolvedValue(reqs()),
      waiveFn,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Waive' }));
    const form = await screen.findByRole('form', { name: 'Waive requirement' });
    expect(form).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Justification'), { target: { value: 'accepted risk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(waiveFn).toHaveBeenCalledTimes(1));
    expect(waiveFn.mock.calls[0][0]).toBe('req-1');
    expect(waiveFn.mock.calls[0][1]).toMatchObject({ authority: 'INTERNAL', justification: 'accepted risk' });
  });

  it('no :read scope → access-denied, no requirements request', () => {
    const getRequirementsFn = vi.fn();
    renderView({ sessionOverride: makeSession(['placement:read']), getRequirementsFn });
    expect(screen.getByText(/do not have access/)).toBeTruthy();
    expect(getRequirementsFn).not.toHaveBeenCalled();
  });
});
