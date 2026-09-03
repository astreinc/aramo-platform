import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConfigureZoomCredentialDialog } from './ConfigureZoomCredentialDialog';
import type { CommunicationProviderConfig } from './provider-config-types';

// COMM-C1 — the credential is WRITE-ONLY. This dialog posts the bundle once and
// clears it; it is never read back or retained in the DOM after it is saved.

const RESULT: CommunicationProviderConfig = {
  provider_key: 'zoom_phone',
  display_name: 'Zoom Phone',
  connection_id: 'c1',
  configuration_state: 'configured',
  status: 'configured',
  credential_configured: true,
  provider_account_id: null,
  last_successful_at: null,
  last_error_code: null,
  recruiter_mapping_count: 0,
  capabilities: {
    voice: { supported: true, execution: 'available' },
    sms: { supported: true, execution: 'not_available' },
  },
};

describe('ConfigureZoomCredentialDialog', () => {
  it('posts the bundle and does not retain the secret in the DOM afterwards', async () => {
    const configureFn = vi.fn().mockResolvedValue(RESULT);
    const onConfigured = vi.fn();
    render(
      <ToastProvider>
        <ConfigureZoomCredentialDialog
          open
          onOpenChange={vi.fn()}
          onConfigured={onConfigured}
          configureFn={configureFn}
        />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByTestId('zoom-access-token-input'), {
      target: { value: 'atk-super-secret' },
    });
    fireEvent.click(screen.getByTestId('zoom-credential-submit'));

    await waitFor(() => expect(configureFn).toHaveBeenCalledTimes(1));
    expect(configureFn).toHaveBeenCalledWith({ access_token: 'atk-super-secret' });
    expect(onConfigured).toHaveBeenCalledWith(RESULT);
    // After a successful save the field is cleared — the secret is not retained.
    await waitFor(() =>
      expect((screen.getByTestId('zoom-access-token-input') as HTMLInputElement).value).toBe(''),
    );
  });

  it('does not submit an empty access token', () => {
    const configureFn = vi.fn();
    render(
      <ToastProvider>
        <ConfigureZoomCredentialDialog open onOpenChange={vi.fn()} onConfigured={vi.fn()} configureFn={configureFn} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId('zoom-credential-submit'));
    expect(configureFn).not.toHaveBeenCalled();
  });
});
