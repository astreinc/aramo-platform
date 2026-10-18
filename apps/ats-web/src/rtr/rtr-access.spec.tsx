import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { canExecuteRtr, canSendRtr, SignSubscriptionProvider, useSignSubscribed } from './rtr-access';

// PO ruling 2026-10-18: Send RTR needs document:create AND document:execute AND the
// tenant's Aramo Sign subscription; send-existing / remind need document:execute + Sign.
describe('rtr-access', () => {
  const BOTH = ['document:create', 'document:execute'];

  it('Send RTR: both permissions and the Sign subscription', () => {
    expect(canSendRtr(BOTH, true)).toBe(true);
    expect(canSendRtr(['document:create'], true)).toBe(false);
    expect(canSendRtr(['document:execute'], true)).toBe(false);
    expect(canSendRtr(BOTH, false)).toBe(false);
  });

  it('send-existing / remind: document:execute and the Sign subscription', () => {
    expect(canExecuteRtr(['document:execute'], true)).toBe(true);
    expect(canExecuteRtr(['document:execute'], false)).toBe(false);
    expect(canExecuteRtr(['document:create'], true)).toBe(false);
  });

  function Probe(): JSX.Element {
    return <span data-testid="sub">{String(useSignSubscribed())}</span>;
  }

  it('subscription is true only when known; unknown (loading/error/no provider) hides', () => {
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId('sub')).toHaveTextContent('false');
    rerender(
      <SignSubscriptionProvider subscribed={null}>
        <Probe />
      </SignSubscriptionProvider>,
    );
    expect(screen.getByTestId('sub')).toHaveTextContent('false');
    rerender(
      <SignSubscriptionProvider subscribed>
        <Probe />
      </SignSubscriptionProvider>,
    );
    expect(screen.getByTestId('sub')).toHaveTextContent('true');
  });
});
