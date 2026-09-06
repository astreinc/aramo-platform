import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementPolicyPanel } from './EngagementPolicyPanel';
import type { EngagementPolicyState, PublishEngagementPolicyInput } from './engagement-policy-api';

const CAPS = [
  { channel: 'voice' as const, available: true },
  { channel: 'email' as const, available: true },
];
const loadCaps = () => vi.fn().mockResolvedValue(CAPS);
// Default: both channels have a configured Tenant provider (fully available).
const READY = { voice: true, email: true };

function panel(
  state: EngagementPolicyState,
  publishFn = vi.fn().mockResolvedValue(undefined),
  canWrite = true,
  readiness = READY,
) {
  return render(
    <EngagementPolicyPanel
      canRead
      canWrite={canWrite}
      loadStateFn={vi.fn().mockResolvedValue(state)}
      loadCapabilitiesFn={loadCaps()}
      loadReadinessFn={vi.fn().mockResolvedValue(readiness)}
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
        enforcement_mode: 'ENFORCING',
      },
    });
    expect(await screen.findByTestId('engagement-policy-status-published')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-policy-effective-mode')).toHaveTextContent(/enforcing/i);
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
    expect(input.enforcement_mode).toBe('ADVISORY'); // new-draft default (recommended first step)
    // Provider neutrality: the whole payload carries no vendor terms.
    const json = JSON.stringify(input).toLowerCase();
    expect(json).not.toMatch(/microsoft|graph|zoom/);
  });

  it('C6 — Email is "Available" only when a Tenant provider is configured; else "Supported by platform"', async () => {
    panel({ governed: false, effective: null }, vi.fn(), true, { voice: true, email: false });
    // Platform-capable but no configured Email provider → truthful, not "Available".
    expect(await screen.findByTestId('engagement-cap-email')).toHaveTextContent(/supported by platform · provider not configured/i);
    expect(screen.getByTestId('engagement-cap-voice')).toHaveTextContent(/available/i);
  });

  it('C6 — a channel with no configured provider cannot be required (toggle disabled)', async () => {
    panel({ governed: false, effective: null }, vi.fn(), true, { voice: true, email: false });
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    expect(screen.getByTestId('engagement-policy-email-toggle')).toBeDisabled();
    expect(screen.getByTestId('engagement-policy-voice-toggle')).toBeEnabled();
    expect(screen.getByTestId('engagement-policy-email-unavailable')).toBeInTheDocument();
  });

  it('enforcement radios map 1:1 to the backend enum and are carried on publish', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-configure'));
    fireEvent.click(screen.getByTestId('engagement-policy-email-toggle'));
    // All three modes present.
    expect(screen.getByTestId('engagement-policy-mode-ADVISORY')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-policy-mode-ENFORCING')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-policy-mode-ENFORCING_WITH_OVERRIDE')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('engagement-policy-mode-ENFORCING_WITH_OVERRIDE'));
    fireEvent.click(screen.getByTestId('engagement-policy-review'));
    fireEvent.click(screen.getByTestId('engagement-policy-publish'));
    await waitFor(() => expect(publishFn).toHaveBeenCalledTimes(1));
    expect((publishFn.mock.calls[0][0] as PublishEngagementPolicyInput).enforcement_mode).toBe('ENFORCING_WITH_OVERRIDE');
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
