import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorIdentity } from '../identity/identity';

import { AccountMenu } from './AccountMenu';

const ID = {
  initials: 'MO',
  name: 'Maya Okafor',
  email: 'maya.okafor@aramo.ai',
  role: 'Super admin',
  tenant: 'Aramo Platform',
} as unknown as OperatorIdentity;

describe('AccountMenu notice', () => {
  it('shows the notice under the identity block when given', () => {
    render(<AccountMenu identity={ID} onSwitchAccount={vi.fn()} onSignOut={vi.fn()} notice="You have unsaved changes." />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Maya Okafor' }));
    expect(screen.getByRole('status')).toHaveTextContent('You have unsaved changes.');
  });

  it('renders no notice by default', () => {
    render(<AccountMenu identity={ID} onSwitchAccount={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Maya Okafor' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
