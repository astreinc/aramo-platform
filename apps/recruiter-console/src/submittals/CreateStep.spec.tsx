import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CreateStep } from './CreateStep';
import type { MatchListSummary } from './types';

const ENTRUSTABLE: MatchListSummary = {
  examination_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  talent_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
  job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
  tier: 'ENTRUSTABLE',
  rank_ordinal: 1,
};

const STRETCH: MatchListSummary = { ...ENTRUSTABLE, tier: 'STRETCH' };

describe('CreateStep', () => {
  it('STRETCH-tier examinations short-circuit with R9 messaging (no form rendered)', () => {
    render(
      <CreateStep
        talentRecordId="bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb"
        requisitionId="cccccccc-cccc-7ccc-8ccc-cccccccccccc"
        examination={STRETCH}
        idempotencyKey="0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00"
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Stretch-tier/)).toBeInTheDocument();
    // No submit button — the form does not render.
    expect(
      screen.queryByRole('button', { name: /Create submittal/ }),
    ).not.toBeInTheDocument();
  });

  it('ENTRUSTABLE tier renders the form with the submit button disabled until required fields are filled', () => {
    render(
      <CreateStep
        talentRecordId="bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb"
        requisitionId="cccccccc-cccc-7ccc-8ccc-cccccccccccc"
        examination={ENTRUSTABLE}
        idempotencyKey="0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00"
        onCreated={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: /Create submittal/ });
    expect(btn).toBeDisabled();
  });
});
