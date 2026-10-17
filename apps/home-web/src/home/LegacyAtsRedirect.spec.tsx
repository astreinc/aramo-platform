import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { LegacyAtsRedirect, legacyAtsHref } from './LegacyAtsRedirect';

// D-ORG-2 — bookmark compatibility: a pre-T1 ATS deep link on the tenant host is
// forwarded to the ATS SPA at /ats/<path>, query + fragment preserved.
describe('LegacyAtsRedirect', () => {
  it('prefixes the ATS base and preserves the search + hash', () => {
    expect(legacyAtsHref({ pathname: '/talent/t-1', search: '?tab=docs', hash: '#x' })).toBe('/ats/talent/t-1?tab=docs#x');
    expect(legacyAtsHref({ pathname: '/requisitions', search: '', hash: '' })).toBe('/ats/requisitions');
  });

  it('forwards the current location on mount (full navigation seam) and offers a manual link', () => {
    const onRedirect = vi.fn();
    render(
      <MemoryRouter initialEntries={['/talent/t-1?tab=docs']}>
        <Routes>
          <Route path="*" element={<LegacyAtsRedirect onRedirect={onRedirect} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(onRedirect).toHaveBeenCalledWith('/ats/talent/t-1?tab=docs');
    expect(screen.getByRole('link', { name: /continue to the ats/i })).toHaveAttribute('href', '/ats/talent/t-1?tab=docs');
  });
});
