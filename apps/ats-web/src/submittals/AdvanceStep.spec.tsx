import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngagementReadiness } from '../engagement/engagement-api';

import { AdvanceStep } from './AdvanceStep';
import type { TalentSubmittalRecordView } from './types';

// COMM PART A (A9) — the override affordance is surfaced in the REAL submit flow
// (AdvanceStep) when Submit to ATS is engagement-blocked, reusing the existing
// EngagementOverridePrompt + submitToAts(engagement_override).

const submitToAts = vi.fn();
const getEngagementReadiness = vi.fn();
const useSession = vi.fn();

vi.mock('./submittals-api', () => ({
  submitToAts: (...a: unknown[]) => submitToAts(...a),
  markReady: vi.fn(),
  confirmAts: vi.fn(),
}));
vi.mock('../engagement/engagement-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getEngagementReadiness: (...a: unknown[]) => getEngagementReadiness(...a),
}));
vi.mock('@aramo/fe-foundation', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSession: () => useSession(),
}));

const SUBMITTAL: TalentSubmittalRecordView = {
  id: 'sub-1',
  tenant_id: 't1',
  talent_id: 'talent-1',
  job_id: 'req-1',
  evidence_package_id: 'ep-1',
  pinned_examination_id: 'ex-1',
  state: 'ready_for_review',
  created_by: 'u1',
  justification: null,
  failed_criterion_acknowledgments: null,
  created_at: '2026-01-01T00:00:00Z',
  confirmed_at: null,
  revoked_at: null,
  revoked_by: null,
  revocation_justification: null,
};

const OVERRIDE_READINESS: EngagementReadiness = {
  governed: true,
  policy_present: true,
  satisfied: false,
  unavailable: false,
  missing: ['voice'],
  results: [],
  capabilities: [],
  enforcement_mode: 'ENFORCING_WITH_OVERRIDE',
  override_available: true,
};

function withScopes(scopes: string[]) {
  useSession.mockReturnValue({ status: 'authenticated', session: { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 } });
}
const blockErr = new ApiError(409, 'incomplete', 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE');

afterEach(() => vi.clearAllMocks());

describe('AdvanceStep — engagement override (PART A / A9)', () => {
  it('authorized override: block → prompt → reason → re-submits with engagement_override → advances', async () => {
    withScopes(['engagement:policy:override']);
    getEngagementReadiness.mockResolvedValue(OVERRIDE_READINESS);
    submitToAts.mockRejectedValueOnce(blockErr).mockResolvedValueOnce({ submittal: { ...SUBMITTAL, state: 'submitted_to_ats' } });
    const onAdvanced = vi.fn();
    render(<AdvanceStep submittal={SUBMITTAL} idempotencyKey="k1" onAdvanced={onAdvanced} />);

    fireEvent.click(screen.getByRole('button', { name: /submit to ats/i }));
    await waitFor(() => expect(screen.getByTestId('engagement-override-prompt')).toBeInTheDocument());

    // Missing reason → Override disabled.
    expect(screen.getByTestId('engagement-override-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('engagement-override-reason'), { target: { value: 'Phone-screened; evidence pending.' } });
    fireEvent.click(screen.getByTestId('engagement-override-submit'));

    await waitFor(() => expect(onAdvanced).toHaveBeenCalled());
    // Second submit carried the override reason (fresh idempotency key).
    const overrideCall = submitToAts.mock.calls[1];
    expect(overrideCall[2]).toEqual({ reason: 'Phone-screened; evidence pending.' });
    expect(overrideCall[1]).not.toBe('k1'); // fresh key (changed body)
  });

  it('unauthorized user cannot override: block → informational message, NO reason control', async () => {
    withScopes(['pipeline:read']); // no override scope
    getEngagementReadiness.mockResolvedValue(OVERRIDE_READINESS);
    submitToAts.mockRejectedValueOnce(blockErr);
    render(<AdvanceStep submittal={SUBMITTAL} idempotencyKey="k1" onAdvanced={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /submit to ats/i }));
    await waitFor(() => expect(screen.getByTestId('engagement-override-blocked')).toBeInTheDocument());
    expect(screen.queryByTestId('engagement-override-reason')).toBeNull();
  });

  it('read-error (unavailable) remains fail-closed and non-overridable', async () => {
    withScopes(['engagement:policy:override']);
    getEngagementReadiness.mockResolvedValue({ ...OVERRIDE_READINESS, unavailable: true });
    submitToAts.mockRejectedValueOnce(blockErr);
    render(<AdvanceStep submittal={SUBMITTAL} idempotencyKey="k1" onAdvanced={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /submit to ats/i }));
    await waitFor(() => expect(screen.getByTestId('engagement-override-unavailable')).toBeInTheDocument());
    expect(screen.queryByTestId('engagement-override-submit')).toBeNull();
  });

  it('a normal (non-engagement) error does NOT surface the override prompt', async () => {
    withScopes(['engagement:policy:override']);
    submitToAts.mockRejectedValueOnce(new ApiError(409, 'state invalid', 'SUBMITTAL_STATE_INVALID'));
    render(<AdvanceStep submittal={SUBMITTAL} idempotencyKey="k1" onAdvanced={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /submit to ats/i }));
    await waitFor(() => expect(screen.getByText(/state invalid|cannot|not/i)).toBeInTheDocument());
    expect(screen.queryByTestId('advance-engagement-override')).toBeNull();
    expect(getEngagementReadiness).not.toHaveBeenCalled();
  });
});
