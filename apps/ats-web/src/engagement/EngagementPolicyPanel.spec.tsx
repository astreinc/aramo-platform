import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementPolicyPanel } from './EngagementPolicyPanel';
import type { EngagementPolicyState, PublishEngagementPolicyInput } from './engagement-policy-api';

const CAPS = [
  { channel: 'voice' as const, available: true },
  { channel: 'email' as const, available: true },
];
const loadCaps = () => vi.fn().mockResolvedValue(CAPS);

function panel(state: EngagementPolicyState, publishFn = vi.fn().mockResolvedValue(undefined), canWrite = true) {
  return render(
    <EngagementPolicyPanel
      canRead
      canWrite={canWrite}
      loadStateFn={vi.fn().mockResolvedValue(state)}
      loadCapabilitiesFn={loadCaps()}
      publishFn={publishFn}
      versionFn={() => 'v-test-1'}
    />,
  );
}

describe('EngagementPolicyPanel (COMM-C3 admin)', () => {
  it('Case A — never configured → Not configured / non-enforcing', async () => {
    panel({ governed: false, effective: null });
    expect(await screen.findByTestId('engagement-policy-status-not-configured')).toHaveTextContent(
      /not configured/i,
    );
    expect(screen.getByTestId('engagement-policy-status-not-configured')).toHaveTextContent(
      /no engagement requirements are currently enforced/i,
    );
  });

  it('governed but no effective → No active policy (fail-closed)', async () => {
    panel({ governed: true, effective: null });
    expect(await screen.findByTestId('engagement-policy-status-no-active')).toHaveTextContent(/no active policy/i);
  });

  it('published policy → lists enforced requirements', async () => {
    panel({
      governed: true,
      effective: {
        requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }],
        layers: [{ scope: 'TENANT', version: 'v1', checksum: 'abc' }],
        composite_version: 'TENANT:v1:abc',
      },
    });
    expect(await screen.findByTestId('engagement-policy-status-published')).toHaveTextContent(/enforcing/i);
    expect(screen.getByTestId('engagement-policy-req-email')).toHaveTextContent(/email evidence required/i);
    // "email sent" ≠ "responded": the requirement must not claim reply/open.
    expect(screen.getByTestId('engagement-policy-req-email')).not.toHaveTextContent(/repl|open|read/i);
  });

  it('Case B — draft toggles do NOT publish; enforcement unchanged until Publish', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    fireEvent.click(screen.getByTestId('engagement-policy-email-toggle'));
    expect(screen.getByTestId('engagement-policy-draft')).toBeInTheDocument();
    expect(publishFn).not.toHaveBeenCalled(); // draft is config-only
  });

  it('Case F — read-only (no write scope): no edit controls', async () => {
    panel({ governed: false, effective: null }, vi.fn(), false);
    expect(await screen.findByTestId('engagement-policy-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('engagement-policy-configure')).toBeNull();
  });

  it('forbidden when lacking read scope', async () => {
    render(<EngagementPolicyPanel canRead={false} canWrite={false} />);
    expect(await screen.findByTestId('engagement-policy-forbidden')).toBeInTheDocument();
  });

  it('publish requires >=1 enabled requirement (all-OFF cannot publish)', async () => {
    panel({ governed: false, effective: null });
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    expect(screen.getByTestId('engagement-policy-review')).toBeDisabled();
  });

  it('Case G — publish sends a provider-neutral email requirement, shows warning first', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    fireEvent.click(screen.getByTestId('engagement-policy-email-toggle'));
    fireEvent.click(screen.getByTestId('engagement-policy-review'));
    expect(screen.getByTestId('engagement-policy-publish-warning')).toHaveTextContent(/enforce these engagement requirements/i);
    fireEvent.click(screen.getByTestId('engagement-policy-publish'));
    await waitFor(() => expect(publishFn).toHaveBeenCalledTimes(1));
    const input = publishFn.mock.calls[0][0] as PublishEngagementPolicyInput;
    expect(input.scope).toBe('TENANT');
    expect(input.requirements).toEqual([{ channel: 'email', required: true, condition: 'recorded_evidence' }]);
    // Provider neutrality: the whole payload carries no vendor terms.
    const json = JSON.stringify(input).toLowerCase();
    expect(json).not.toMatch(/microsoft|graph|zoom/);
  });

  it('publishes email + voice with minimum strength when both enabled', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    fireEvent.click(screen.getByTestId('engagement-policy-email-toggle'));
    fireEvent.click(screen.getByTestId('engagement-policy-voice-toggle'));
    fireEvent.change(screen.getByTestId('engagement-policy-voice-strength'), {
      target: { value: 'PROVIDER_VERIFIED' },
    });
    fireEvent.click(screen.getByTestId('engagement-policy-review'));
    fireEvent.click(screen.getByTestId('engagement-policy-publish'));
    await waitFor(() => expect(publishFn).toHaveBeenCalledTimes(1));
    const input = publishFn.mock.calls[0][0] as PublishEngagementPolicyInput;
    expect(input.requirements).toContainEqual({ channel: 'email', required: true, condition: 'recorded_evidence' });
    expect(input.requirements).toContainEqual({
      channel: 'voice',
      required: true,
      condition: 'two_way_conversation',
      minimum_strength: 'PROVIDER_VERIFIED',
    });
  });
});
