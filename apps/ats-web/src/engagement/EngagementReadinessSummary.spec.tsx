import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementReadinessSummary } from './EngagementReadinessSummary';
import type { EngagementReadiness } from './engagement-api';

// COMM-C3 — the recruiter readiness summary must be truthful about the amendment
// three-state (dormant / no-effective / present) and MUST NOT claim Qualified (R19).

function readiness(over: Partial<EngagementReadiness>): EngagementReadiness {
  return {
    governed: true,
    policy_present: true,
    satisfied: false,
    unavailable: false,
    missing: [],
    results: [],
    capabilities: [],
    ...over,
  };
}

const load = (r: EngagementReadiness) => vi.fn().mockResolvedValue(r);

describe('EngagementReadinessSummary', () => {
  it('dormant (never governed) → submittal proceeds under standard gates', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(readiness({ governed: false, policy_present: false, satisfied: true }))}
      />,
    );
    expect(await screen.findByTestId('engagement-readiness-dormant')).toBeInTheDocument();
  });

  it('governed but no effective policy → blocked (fail-closed)', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(readiness({ governed: true, policy_present: false, satisfied: false }))}
      />,
    );
    expect(await screen.findByTestId('engagement-readiness-nopolicy')).toBeInTheDocument();
  });

  it('voice satisfied → requirements met, no Qualified claim', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(
          readiness({
            satisfied: true,
            results: [{ channel: 'voice', required: true, status: 'satisfied' }],
          }),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('engagement-readiness')).toBeInTheDocument());
    expect(screen.getByTestId('engagement-readiness-verdict')).toHaveTextContent('Engagement requirements met');
    expect(document.body.innerHTML).not.toMatch(/qualified/i);
  });

  it('voice missing → blocked verdict', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(
          readiness({
            satisfied: false,
            missing: ['voice'],
            results: [{ channel: 'voice', required: true, status: 'missing' }],
          }),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('engagement-readiness-verdict')).toBeInTheDocument());
    expect(screen.getByTestId('engagement-readiness-verdict')).toHaveTextContent('blocked');
  });
});
