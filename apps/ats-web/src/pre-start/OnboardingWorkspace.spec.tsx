import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OnboardingWorkspace } from './OnboardingWorkspace';
import type { PreStartPlacementRequirements, PreStartRequirementView, SatisfactionPolicy } from './types';

// L5-P7 — the onboarding workspace renders readiness + the governed affordances and
// fires the action callbacks; the BE is the authority (mirrors OfferPanel).

function reqView(over: Partial<PreStartRequirementView> = {}): PreStartRequirementView {
  return {
    id: over.id ?? 'req-1',
    placement_process_id: 'plc-1',
    requirement_type: over.requirement_type ?? 'BACKGROUND_CHECK',
    label: over.label ?? 'Background check',
    blocking: over.blocking ?? true,
    satisfaction_policy: (over.satisfaction_policy ?? 'SELF_ATTEST') as SatisfactionPolicy,
    status: over.status ?? 'PENDING',
    owner_role: over.owner_role ?? null,
    completed_at: null,
    completed_by: null,
    evidence_reference: null,
    evidence_restricted: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}
function data(over: Partial<PreStartPlacementRequirements> = {}): PreStartPlacementRequirements {
  return {
    materialized: over.materialized ?? true,
    ready: over.ready ?? false,
    blocking_unresolved_count: over.blocking_unresolved_count ?? 1,
    requirements: over.requirements ?? [reqView()],
  };
}
const ACT = ['pre_start_requirement:act'];

describe('OnboardingWorkspace', () => {
  it('renders the requirement label, status, and the blocking-count readiness', () => {
    render(<OnboardingWorkspace data={data()} scopes={ACT} onRequirementAction={vi.fn()} onMarkReady={vi.fn()} />);
    expect(screen.getByText('Background check')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText(/1 blocking requirement/)).toBeTruthy();
  });

  it('a SELF_ATTEST PENDING requirement shows Satisfy; clicking fires onRequirementAction(SATISFY)', () => {
    const onAction = vi.fn();
    render(<OnboardingWorkspace data={data()} scopes={ACT} onRequirementAction={onAction} onMarkReady={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Satisfy' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toBe('req-1');
    expect(onAction.mock.calls[0][1]).toMatchObject({ action: 'SATISFY' });
  });

  it('a VERIFICATION_REQUIRED requirement shows the badge + Verify (with :verify), not Satisfy', () => {
    const d = data({ requirements: [reqView({ satisfaction_policy: 'VERIFICATION_REQUIRED' })] });
    render(<OnboardingWorkspace data={d} scopes={['pre_start_requirement:verify']} onRequirementAction={vi.fn()} onMarkReady={vi.fn()} />);
    expect(screen.getByText('Verification required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Satisfy' })).toBeNull();
  });

  it('Mark-ready shows only when ready + :act, and fires onMarkReady', () => {
    const onMarkReady = vi.fn();
    const { rerender } = render(
      <OnboardingWorkspace data={data({ ready: false })} scopes={ACT} onRequirementAction={vi.fn()} onMarkReady={onMarkReady} />,
    );
    expect(screen.queryByRole('button', { name: 'Mark ready to start' })).toBeNull();

    rerender(
      <OnboardingWorkspace
        data={data({ ready: true, blocking_unresolved_count: 0, requirements: [reqView({ status: 'SATISFIED' })] })}
        scopes={ACT}
        onRequirementAction={vi.fn()}
        onMarkReady={onMarkReady}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Mark ready to start' });
    fireEvent.click(btn);
    expect(onMarkReady).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Ready to start/)).toBeTruthy();
  });

  it('not materialized → shows the preparing state, no requirement rows', () => {
    render(
      <OnboardingWorkspace
        data={data({ materialized: false, ready: false, blocking_unresolved_count: 0, requirements: [] })}
        scopes={ACT}
        onRequirementAction={vi.fn()}
        onMarkReady={vi.fn()}
      />,
    );
    expect(screen.getByText(/Preparing onboarding requirements/)).toBeTruthy();
  });
});
