import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementOverridePrompt } from './EngagementOverridePrompt';
import type { EngagementReadiness } from './engagement-api';

// COMM PART A (A9) — override affordance: authorized-only, reason-required, and
// fail-closed on read-error.

const base: EngagementReadiness = {
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

describe('EngagementOverridePrompt', () => {
  it('renders nothing when override is not available', () => {
    const { container } = render(
      <EngagementOverridePrompt readiness={{ ...base, override_available: false }} canOverride onOverride={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('non-authorized user sees a blocked message but NO reason control (least-visibility)', () => {
    render(<EngagementOverridePrompt readiness={base} canOverride={false} onOverride={vi.fn()} />);
    expect(screen.getByTestId('engagement-override-blocked')).toHaveTextContent(/authorized user may override/i);
    expect(screen.queryByTestId('engagement-override-reason')).toBeNull();
  });

  it('read-error (unavailable) is fail-closed and NOT overridable even for an authorized user', () => {
    render(<EngagementOverridePrompt readiness={{ ...base, unavailable: true }} canOverride onOverride={vi.fn()} />);
    expect(screen.getByTestId('engagement-override-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('engagement-override-submit')).toBeNull();
  });

  it('authorized user: Override disabled until a reason is entered, then submits with the reason', () => {
    const onOverride = vi.fn();
    render(<EngagementOverridePrompt readiness={base} canOverride onOverride={onOverride} />);
    const submit = screen.getByTestId('engagement-override-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('engagement-override-reason'), {
      target: { value: 'Client phone-screened; evidence pending.' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onOverride).toHaveBeenCalledWith('Client phone-screened; evidence pending.');
  });
});
