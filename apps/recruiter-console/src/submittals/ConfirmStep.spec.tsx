import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmStep } from './ConfirmStep';
import type { TalentSubmittalRecordView } from './types';

const SUBMITTAL: TalentSubmittalRecordView = {
  id: 'sub-1',
  tenant_id: 't',
  talent_id: 'tal-1',
  job_id: 'job-1',
  evidence_package_id: 'ep-1',
  pinned_examination_id: 'ex-1',
  state: 'created',
  created_by: 'u',
  justification: null,
  failed_criterion_acknowledgments: null,
  created_at: 'x',
  confirmed_at: null,
  revoked_at: null,
  revoked_by: null,
  revocation_justification: null,
};

function mockConfirm(captured: { body?: unknown }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.body != null) captured.body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ submittal: { ...SUBMITTAL, state: 'handoff_draft' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

const ATT_1 = /communicated directly with this talent/i;
const ATT_2 = /rate, availability, and authorization details/i;
const ATT_3 = /ready for submission to the client/i;

describe('ConfirmStep (submittal attestation gate)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the three locked attestations in canonical talent vocab, start unchecked', () => {
    render(
      <ConfirmStep submittal={SUBMITTAL} idempotencyKey="k" onConfirmed={vi.fn()} talentName="Aisha Khan" requisitionTitle="Senior Rust Engineer" />,
    );
    expect(screen.getByText('Submit Aisha Khan to client')).toBeInTheDocument();
    const checkboxes = [ATT_1, ATT_2, ATT_3].map((re) =>
      screen.getByRole('checkbox', { name: re }),
    );
    expect(checkboxes).toHaveLength(3);
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked());
  });

  it('drops system constraint chips for a reserved Core seam (gap #4 / R10)', () => {
    render(
      <ConfirmStep submittal={SUBMITTAL} idempotencyKey="k" onConfirmed={vi.fn()} />,
    );
    const seam = screen.getByRole('region', { name: 'Constraint compliance' });
    expect(seam.textContent).toContain('Aramo Core');
    // No pass/partial/fail computed verdict rendered.
    expect(screen.queryByText(/within max|partial|fail/i)).toBeNull();
  });

  it('keeps Submit DISABLED until all three attestations are checked, and unchecking re-disables', () => {
    render(
      <ConfirmStep submittal={SUBMITTAL} idempotencyKey="k" onConfirmed={vi.fn()} />,
    );
    const submit = screen.getByRole('button', { name: 'Submit to client' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: ATT_1 }));
    fireEvent.click(screen.getByRole('checkbox', { name: ATT_2 }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: ATT_3 }));
    expect(submit).toBeEnabled();
    // The literal-true invariant: unchecking any one re-disables.
    fireEvent.click(screen.getByRole('checkbox', { name: ATT_2 }));
    expect(submit).toBeDisabled();
  });

  it('confirms with all three attestations literal-true and advances the submittal', async () => {
    const captured: { body?: unknown } = {};
    mockConfirm(captured);
    const onConfirmed = vi.fn();
    render(
      <ConfirmStep submittal={SUBMITTAL} idempotencyKey="k" onConfirmed={onConfirmed} />,
    );
    [ATT_1, ATT_2, ATT_3].forEach((re) =>
      fireEvent.click(screen.getByRole('checkbox', { name: re })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit to client' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
    expect(captured.body).toEqual({
      attestations: {
        talent_evidence_reviewed: true,
        constraints_reviewed: true,
        submittal_risk_acknowledged: true,
      },
    });
  });

  it('shows the immutable-on-submit notice', () => {
    render(
      <ConfirmStep submittal={SUBMITTAL} idempotencyKey="k" onConfirmed={vi.fn()} />,
    );
    expect(
      screen.getByText(/once submitted, the package is locked/i),
    ).toBeInTheDocument();
  });
});
