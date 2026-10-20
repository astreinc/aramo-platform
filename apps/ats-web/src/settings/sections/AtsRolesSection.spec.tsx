import { ssoEntryHref } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AtsRolesSection, isAtsRole } from './AtsRolesSection';

// ATS roles & permissions (accepted change log A4) — a READ-ONLY reference with
// no assignment/edit controls; "Manage user access" opens Organization
// administration with this page as the return context.
afterEach(() => vi.restoreAllMocks());

const CATALOG = {
  roles: [
    { key: 'recruiter', display: 'Recruiter', description: 'Works talent.', tier: 'Operations', scopes: ['talent:read'] },
    { key: 'sign_sender', display: 'Sign Sender', description: '', tier: 'Sign', scopes: ['sign:envelope:send'] },
    { key: 'org_admin', display: 'Organization Admin', description: '', tier: 'Administration', scopes: ['tenant:admin:profile'] },
  ],
};

describe('AtsRolesSection', () => {
  it('lists ATS roles only (no Sign roles, no org_admin), with no edit or assign controls', async () => {
    window.history.pushState({}, '', '/ats/admin/settings/roles');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    render(<AtsRolesSection />);
    await waitFor(() => expect(screen.getAllByText('Recruiter').length).toBeGreaterThan(0));
    expect(screen.queryByText('Sign Sender')).toBeNull();
    expect(screen.queryByText('Organization Admin')).toBeNull();
    expect(screen.getByText(/Read-only reference/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /assign|edit role|save/i })).toBeNull();
    expect(screen.getByTestId('ats-roles-manage-access')).toHaveAttribute(
      'href',
      ssoEntryHref(`/org/roles?from=ats&return=${encodeURIComponent('/ats/admin/settings/roles')}`, 'org'),
    );
  });

  it('isAtsRole partitions the catalog for display only', () => {
    expect(isAtsRole({ key: 'recruiter' } as never)).toBe(true);
    expect(isAtsRole({ key: 'sign_owner' } as never)).toBe(false);
    expect(isAtsRole({ key: 'org_admin' } as never)).toBe(false);
  });
});
