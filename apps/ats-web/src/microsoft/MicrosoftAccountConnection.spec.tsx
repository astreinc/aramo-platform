import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MicrosoftAccountConnection } from './MicrosoftAccountConnection';
import type { MicrosoftBindingStatus } from './microsoft-api';

// My Settings → Connected accounts: the per-user Microsoft mailbox connect.
// Context-free (no talent/req); Connect redirects to the authorize URL.

function bind(over: Partial<MicrosoftBindingStatus>): MicrosoftBindingStatus {
  return { connection_id: 'c1', bound: true, status: 'active', needs_reauthorization: false, ...over };
}

describe('MicrosoftAccountConnection', () => {
  it('not connected → "Connect account" redirects to the Microsoft authorize URL', async () => {
    const onNavigate = vi.fn();
    render(
      <MicrosoftAccountConnection
        loadStatusFn={vi.fn().mockResolvedValue(
          bind({ bound: false, status: 'unconfigured', needs_reauthorization: true }),
        )}
        startAuthorizeFn={vi.fn().mockResolvedValue({
          authorize_url: 'https://login.microsoftonline.example/x',
        })}
        onNavigate={onNavigate}
      />,
    );
    expect(await screen.findByTestId('microsoft-account-status')).toHaveTextContent(/not connected/i);
    fireEvent.click(screen.getByTestId('microsoft-account-connect'));
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('https://login.microsoftonline.example/x'),
    );
  });

  it('connected → shows "Connected" and no connect button', async () => {
    render(<MicrosoftAccountConnection loadStatusFn={vi.fn().mockResolvedValue(bind({}))} />);
    expect(await screen.findByTestId('microsoft-account-status')).toHaveTextContent(/connected/i);
    expect(screen.queryByTestId('microsoft-account-connect')).toBeNull();
  });

  it('bound but expired → "Reconnect needed" with a Reconnect action', async () => {
    render(
      <MicrosoftAccountConnection
        loadStatusFn={vi.fn().mockResolvedValue(bind({ needs_reauthorization: true }))}
      />,
    );
    expect(await screen.findByTestId('microsoft-account-status')).toHaveTextContent(/reconnect needed/i);
    expect(screen.getByTestId('microsoft-account-connect')).toHaveTextContent(/reconnect/i);
  });
});
