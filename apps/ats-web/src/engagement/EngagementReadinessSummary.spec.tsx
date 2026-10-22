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

  // ---- ATS-QA-1 I-1 UX — plain copy + a next step; fail-closed kept; no raw enums ----
  it('governed but no effective policy → plain blocked copy with a next step (still fail-closed)', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(readiness({ governed: true, policy_present: false, satisfied: false }))}
      />,
    );
    const el = await screen.findByTestId('engagement-readiness-nopolicy');
    expect(el).toHaveTextContent('Client submittal is blocked');
    expect(el).toHaveTextContent('Next step: ask your Aramo admin to publish one.');
    expect(el.textContent).not.toMatch(/resolves/);
  });

  it('missing voice → plain status label and a channel-specific next step', async () => {
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
    await waitFor(() => expect(screen.getByTestId('engagement-readiness')).toBeInTheDocument());
    expect(screen.getByText('Voice conversation — not recorded yet')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-readiness-next-step')).toHaveTextContent(
      'Next step: log a voice conversation with the Talent.',
    );
  });

  it('unavailable → next step says to check again (verdict stays blocked)', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(
          readiness({
            satisfied: false,
            unavailable: true,
            results: [{ channel: 'email', required: true, status: 'unavailable' }],
          }),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('engagement-readiness-verdict')).toHaveTextContent('blocked'));
    expect(screen.getByTestId('engagement-readiness-next-step')).toHaveTextContent(/couldn’t be checked right now/);
  });

  it('an unknown status or channel never renders the raw enum value', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(
          readiness({
            satisfied: false,
            results: [
              { channel: 'sms_future' as never, required: true, status: 'weird_new_status' as never },
            ],
          }),
        )}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('engagement-readiness')).toBeInTheDocument());
    expect(screen.getByText('Engagement requirement — status unknown')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/sms_future|weird_new_status/);
  });

  it('satisfied → no next-step line', async () => {
    render(
      <EngagementReadinessSummary
        talentId="t1"
        requisitionId="r1"
        loadFn={load(readiness({ satisfied: true, results: [{ channel: 'email', required: true, status: 'satisfied' }] }))}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('engagement-readiness-verdict')).toBeInTheDocument());
    expect(screen.queryByTestId('engagement-readiness-next-step')).toBeNull();
  });
});
