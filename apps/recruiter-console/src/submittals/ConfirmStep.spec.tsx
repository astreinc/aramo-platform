import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmStep } from './ConfirmStep';
import type { TalentSubmittalRecordView } from './types';

const baseSubmittal: TalentSubmittalRecordView = {
  id: '99990000-0000-7000-8000-000000000001',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  talent_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
  job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
  evidence_package_id: '99990000-0000-7000-8000-000000000002',
  pinned_examination_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  state: 'created',
  created_by: '00000000-0000-7000-8000-000000000bb1',
  justification: null,
  failed_criterion_acknowledgments: null,
  created_at: '2026-05-23T12:00:00Z',
  confirmed_at: null,
  revoked_at: null,
  revoked_by: null,
  revocation_justification: null,
};

describe('ConfirmStep', () => {
  it('attestations START UNCHECKED (the recruiter must affirmatively check each)', () => {
    render(
      <ConfirmStep
        submittal={baseSubmittal}
        idempotencyKey="0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00"
        onConfirmed={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    checkboxes.forEach((cb) => {
      expect(cb).not.toBeChecked();
    });
  });

  it('Confirm button is disabled until ALL THREE are checked', () => {
    render(
      <ConfirmStep
        submittal={baseSubmittal}
        idempotencyKey="0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00"
        onConfirmed={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: /Confirm submittal/ });
    expect(btn).toBeDisabled();

    const checkboxes = screen.getAllByRole('checkbox');
    const cb1 = checkboxes[0];
    const cb2 = checkboxes[1];
    const cb3 = checkboxes[2];
    if (cb1 === undefined || cb2 === undefined || cb3 === undefined) {
      throw new Error('expected three checkboxes');
    }
    fireEvent.click(cb1);
    expect(btn).toBeDisabled();
    fireEvent.click(cb2);
    expect(btn).toBeDisabled();
    fireEvent.click(cb3);
    expect(btn).toBeEnabled();
  });

  it('unchecking any one re-disables Confirm (the literal-true invariant)', () => {
    render(
      <ConfirmStep
        submittal={baseSubmittal}
        idempotencyKey="0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00"
        onConfirmed={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: /Confirm submittal/ });
    const checkboxes = screen.getAllByRole('checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));
    expect(btn).toBeEnabled();
    const middle = checkboxes[1];
    if (middle === undefined) throw new Error('expected three checkboxes');
    fireEvent.click(middle);
    expect(btn).toBeDisabled();
  });
});
