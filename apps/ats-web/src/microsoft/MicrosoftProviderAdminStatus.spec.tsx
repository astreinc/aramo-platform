import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MicrosoftProviderAdminStatus } from './MicrosoftProviderAdminStatus';

describe('MicrosoftProviderAdminStatus', () => {
  it('renders capabilities + recruiter mapping counts', async () => {
    render(
      <MicrosoftProviderAdminStatus
        loadFn={vi.fn().mockResolvedValue({
          connection_id: 'c1',
          provider_key: 'microsoft_graph',
          capabilities: { email: true, meeting: true },
          identities: { active: 3, unmapped: 0, disabled: 1, reauth_required: 2 },
        })}
      />,
    );
    expect(await screen.findByTestId('microsoft-provider-status')).toBeInTheDocument();
    expect((await screen.findByTestId('microsoft-cap-email')).textContent).toMatch(/available/i);
    expect((await screen.findByTestId('microsoft-count-active')).textContent).toBe('3');
    expect((await screen.findByTestId('microsoft-count-reauth')).textContent).toBe('2');
  });

  it('shows an unconfigured message when the tenant has no Microsoft connection', async () => {
    render(
      <MicrosoftProviderAdminStatus loadFn={vi.fn().mockRejectedValue(new Error('not configured'))} />,
    );
    expect(await screen.findByTestId('microsoft-provider-unconfigured')).toBeInTheDocument();
  });
});
