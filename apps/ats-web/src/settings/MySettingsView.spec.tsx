import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Stub the per-user Microsoft connect (tested on its own) so this is a pure
// structural proof of the My Settings page.
vi.mock('../microsoft/MicrosoftAccountConnection', () => ({
  MicrosoftAccountConnection: () => <div data-testid="microsoft-account-connection" />,
}));

import { MySettingsView } from './MySettingsView';

describe('MySettingsView', () => {
  it('renders the personal My Settings page with Connected accounts / Notifications / Profile', () => {
    render(
      <MemoryRouter>
        <MySettingsView />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('my-settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My Settings' })).toBeInTheDocument();
    expect(screen.getByText('Connected accounts')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    // The per-user Microsoft mailbox connect is hosted here.
    expect(screen.getByTestId('microsoft-account-connection')).toBeInTheDocument();
  });
});
