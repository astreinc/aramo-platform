import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementPolicyPanel } from './EngagementPolicyPanel';
import type { EngagementPolicyState, PublishEngagementPolicyInput } from './engagement-policy-api';

// COMM-C3 admin — prototype-parity rebuild: the panel is ALWAYS-EDITABLE (no
// Configure/Edit/Review gate). Evidence toggles + enforcement radios are live on
// load, seeded from the effective policy; nothing changes until Publish. SMS is
// display-only ("Execution deferred"); Save draft has no backend yet (disabled).

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
  it('Case A — never configured → Not configured chip + non-enforcing notice', async () => {
    panel({ governed: false, effective: null });
    expect(await screen.findByTestId('engagement-policy-status')).toHaveTextContent(/not configured/i);
    expect(screen.getByTestId('engagement-policy-notice')).toHaveTextContent(
      /no engagement requirements are currently enforced/i,
    );
  });

  it('governed but no effective → No active policy chip', async () => {
    panel({ governed: true, effective: null });
    expect(await screen.findByTestId('engagement-policy-status')).toHaveTextContent(/no active policy/i);
  });

  it('published policy → Published chip; controls seed from the effective policy', async () => {
    panel({
      governed: true,
      effective: {
        requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }],
        layers: [{ scope: 'TENANT', version: 'v1', checksum: 'abc' }],
        composite_version: 'TENANT:v1:abc',
        enforcement_mode: 'ENFORCING',
      },
    });
    expect(await screen.findByTestId('engagement-policy-status')).toHaveTextContent(/published/i);
    // The email toggle + enforcement radio reflect the effective policy.
    await waitFor(() =>
      expect(screen.getByTestId('engagement-policy-email-toggle')).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByTestId('engagement-policy-mode-ENFORCING')).toHaveAttribute('aria-checked', 'true');
    // Published state hides the non-enforcing notice.
    expect(screen.queryByTestId('engagement-policy-notice')).toBeNull();
  });

  it('Case B — toggling evidence does NOT publish (nothing changes until Publish)', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-email-toggle'));
    expect(screen.getByTestId('engagement-policy-email-toggle')).toHaveAttribute('aria-checked', 'true');
    expect(publishFn).not.toHaveBeenCalled();
  });

  it('Case F — read-only (no write scope): no publish, toggles disabled', async () => {
    panel({ governed: false, effective: null }, vi.fn(), false);
    expect(await screen.findByTestId('engagement-policy-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('engagement-policy-publish')).toBeNull();
    expect(screen.getByTestId('engagement-policy-email-toggle')).toBeDisabled();
  });

  it('forbidden when lacking read scope', async () => {
    render(<EngagementPolicyPanel canRead={false} canWrite={false} />);
    expect(await screen.findByTestId('engagement-policy-forbidden')).toBeInTheDocument();
  });

  it('publish requires >=1 enabled requirement (all-OFF → Publish disabled)', async () => {
    panel({ governed: false, effective: null });
    expect(await screen.findByTestId('engagement-policy-publish')).toBeDisabled();
  });

  it('Case G — publish sends a provider-neutral email requirement (direct, no warning gate)', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-email-toggle'));
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
    expect(await screen.findByTestId('engagement-cap-email')).toHaveTextContent(
      /supported by platform · provider not configured/i,
    );
    expect(screen.getByTestId('engagement-cap-voice')).toHaveTextContent(/available/i);
  });

  it('C6 — a channel with no configured provider cannot be required (toggle disabled)', async () => {
    panel({ governed: false, effective: null }, vi.fn(), true, { voice: true, email: false });
    expect(await screen.findByTestId('engagement-policy-email-toggle')).toBeDisabled();
    expect(screen.getByTestId('engagement-policy-voice-toggle')).toBeEnabled();
  });

  it('SMS evidence is present but not requirable (execution deferred)', async () => {
    panel({ governed: false, effective: null });
    expect(await screen.findByTestId('engagement-policy-sms-toggle')).toBeDisabled();
  });

  it('enforcement radios map 1:1 to the backend enum and are carried on publish', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-email-toggle'));
    expect(screen.getByTestId('engagement-policy-mode-ADVISORY')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-policy-mode-ENFORCING')).toBeInTheDocument();
    expect(screen.getByTestId('engagement-policy-mode-ENFORCING_WITH_OVERRIDE')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('engagement-policy-mode-ENFORCING_WITH_OVERRIDE'));
    fireEvent.click(screen.getByTestId('engagement-policy-publish'));
    await waitFor(() => expect(publishFn).toHaveBeenCalledTimes(1));
    expect((publishFn.mock.calls[0][0] as PublishEngagementPolicyInput).enforcement_mode).toBe(
      'ENFORCING_WITH_OVERRIDE',
    );
  });

  it('publishes email + voice with minimum strength when both enabled', async () => {
    const publishFn = vi.fn().mockResolvedValue(undefined);
    panel({ governed: false, effective: null }, publishFn);
    fireEvent.click(await screen.findByTestId('engagement-policy-email-toggle'));
    fireEvent.click(screen.getByTestId('engagement-policy-voice-toggle'));
    fireEvent.change(screen.getByTestId('engagement-policy-voice-strength'), {
      target: { value: 'PROVIDER_VERIFIED' },
    });
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
