import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LegacyOrgRedirect } from './LegacyOrgRedirect';

// Accepted change log A2 — pages that moved to Organization administration
// redirect once, with the ATS Settings home as the return context.
describe('LegacyOrgRedirect', () => {
  it.each([
    ['users', '/org/users'],
    ['profile', '/org/profile'],
    ['domain', '/org/domain'],
  ] as const)('%s → %s with the ATS Settings return context', (section, base) => {
    const onRedirect = vi.fn();
    render(<LegacyOrgRedirect section={section} onRedirect={onRedirect} />);
    const expected = `${base}?from=ats&return=${encodeURIComponent('/ats/admin/settings/recruiting')}`;
    expect(onRedirect).toHaveBeenCalledWith(expected);
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', expected);
  });
});
