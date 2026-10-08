import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { DraftsLegacyRedirect } from './DraftsLegacyRedirect';
import * as api from './talent-intake-api';

// §4/§26.19 — the legacy /talent/drafts URL must redirect: drafts exist →
// /talent?view=in-progress, else → /talent. Never a standalone page.

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/talent/drafts']}>
      <Routes>
        <Route path="/talent/drafts" element={<DraftsLegacyRedirect />} />
        <Route path="/talent" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function listReturning(items: unknown[]): void {
  vi.spyOn(api, 'listTalentIntakeDrafts').mockResolvedValue({ items } as never);
}

describe('DraftsLegacyRedirect', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('redirects to /talent?view=in-progress when drafts exist', async () => {
    listReturning([{ id: 'd1', promoted_talent_record_id: null }]);
    renderAt();
    expect(await screen.findByTestId('loc')).toHaveTextContent('/talent?view=in-progress');
  });

  it('redirects to /talent when there are no in-progress drafts', async () => {
    listReturning([]);
    renderAt();
    expect(await screen.findByTestId('loc')).toHaveTextContent('/talent');
    expect(screen.getByTestId('loc')).not.toHaveTextContent('view=in-progress');
  });

  it('falls back to /talent if the list fails (never traps on a dead URL)', async () => {
    vi.spyOn(api, 'listTalentIntakeDrafts').mockRejectedValue(new Error('boom'));
    renderAt();
    expect(await screen.findByTestId('loc')).toHaveTextContent('/talent');
  });
});
