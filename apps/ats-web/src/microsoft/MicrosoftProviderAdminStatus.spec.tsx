import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { MicrosoftProviderAdminStatus } from './MicrosoftProviderAdminStatus';
import type { MicrosoftProviderStatus } from './microsoft-api';

// COMM PART B — Microsoft 365 first-class provider row: configuration state, a
// real Configure path, capabilities, and recruiter mapping counts as a separate
// axis. Tenant configuration ≠ recruiter authorization.

const NOT_CONFIGURED: MicrosoftProviderStatus = {
  configuration_state: 'NOT_CONFIGURED',
  connection_id: null,
  provider_key: 'microsoft_graph',
  capabilities: { email: true, meeting: true },
  identities: { active: 0, unmapped: 0, disabled: 0, reauth_required: 0 },
};
const CONFIGURED: MicrosoftProviderStatus = {
  configuration_state: 'CONFIGURED',
  connection_id: 'c1',
  provider_key: 'microsoft_graph',
  capabilities: { email: true, meeting: true },
  identities: { active: 3, unmapped: 0, disabled: 1, reauth_required: 2 },
};

function renderWith(status: MicrosoftProviderStatus, canWrite = true, configureFn = vi.fn()) {
  return render(
    <ToastProvider>
      <MicrosoftProviderAdminStatus canWrite={canWrite} loadFn={vi.fn().mockResolvedValue(status)} configureFn={configureFn} />
    </ToastProvider>,
  );
}

describe('MicrosoftProviderAdminStatus (PART B)', () => {
  it('NOT_CONFIGURED → shows a Configure affordance (real path, not a flat error)', async () => {
    renderWith(NOT_CONFIGURED);
    expect(await screen.findByTestId('microsoft-provider-state')).toHaveTextContent(/not configured/i);
    expect(screen.getByTestId('microsoft-configure')).toHaveTextContent(/configure/i);
    expect(screen.getByTestId('microsoft-provider-detail')).toHaveTextContent(/not configured/i);
  });

  it('CONFIGURED → shows Configured state, capabilities, and recruiter counts (separate axis)', async () => {
    renderWith(CONFIGURED);
    expect(await screen.findByTestId('microsoft-provider-state')).toHaveTextContent(/configured/i);
    expect(screen.getByTestId('microsoft-caps')).toHaveTextContent(/email — available/i);
    expect(screen.getByTestId('microsoft-caps')).toHaveTextContent(/calendar\/meeting — available/i);
    expect(screen.getByTestId('microsoft-provider-detail')).toHaveTextContent(/3 recruiters connected/i);
    expect(screen.getByTestId('microsoft-provider-detail')).toHaveTextContent(/2 need reauthorization/i);
    expect(screen.getByTestId('microsoft-configure')).toHaveTextContent(/update connection/i);
  });

  it('read-only (no integration:write) → no Configure affordance', async () => {
    renderWith(NOT_CONFIGURED, false);
    expect(await screen.findByTestId('microsoft-provider-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('microsoft-configure')).toBeNull();
  });

  it('Configure → new connection requires the client secret, then posts client_id + authority + secret', async () => {
    const configureFn = vi.fn().mockResolvedValue({ ...CONFIGURED });
    renderWith(NOT_CONFIGURED, true, configureFn);
    fireEvent.click(await screen.findByTestId('microsoft-configure'));
    // Submit is disabled until client id + authority + (required) secret are present.
    const submit = screen.getByTestId('microsoft-configure-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('microsoft-client-id-input'), { target: { value: 'app-123' } });
    fireEvent.change(screen.getByTestId('microsoft-authority-tenant-input'), { target: { value: 'contoso' } });
    expect(submit).toBeDisabled(); // secret still required for a new connection
    fireEvent.change(screen.getByTestId('microsoft-client-secret-input'), { target: { value: 'super-secret' } });
    fireEvent.click(submit);
    await waitFor(() => expect(configureFn).toHaveBeenCalledTimes(1));
    expect(configureFn).toHaveBeenCalledWith({
      client_id: 'app-123',
      authority_tenant: 'contoso',
      client_secret: 'super-secret',
    });
  });

  it('Update (already configured) → secret may be omitted to keep the stored one', async () => {
    const configureFn = vi.fn().mockResolvedValue({ ...CONFIGURED });
    renderWith(CONFIGURED, true, configureFn);
    fireEvent.click(await screen.findByTestId('microsoft-configure'));
    fireEvent.change(screen.getByTestId('microsoft-client-id-input'), { target: { value: 'app-9' } });
    fireEvent.change(screen.getByTestId('microsoft-authority-tenant-input'), { target: { value: 'contoso' } });
    // No secret entered — submit is allowed for an update.
    fireEvent.click(screen.getByTestId('microsoft-configure-submit'));
    await waitFor(() => expect(configureFn).toHaveBeenCalledTimes(1));
    expect(configureFn).toHaveBeenCalledWith({ client_id: 'app-9', authority_tenant: 'contoso' });
  });
});
