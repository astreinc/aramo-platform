import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

// D-ORG-2 — the App Home route map: /login and /signed-out render session-less;
// a pre-T1 ATS bookmark is forwarded without any session probe.
afterEach(() => vi.restoreAllMocks());

describe('App (home-web) — public routes', () => {
  it('/signed-out renders the public signed-out landing without a session', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    render(
      <MemoryRouter initialEntries={['/signed-out']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(/you're signed out/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith('/auth/org/session', expect.anything());
  });

  it('/login?error=… renders the login landing without redirecting', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    render(
      <MemoryRouter initialEntries={['/login?error=TENANT_SUSPENDED']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('Workspace suspended')).toBeInTheDocument();
  });

  it('a pre-T1 ATS bookmark is forwarded to /ats/<path> (manual link present)', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, replace } });
    try {
      render(
        <MemoryRouter initialEntries={['/requisitions/r-1?tab=pipeline']}>
          <App />
        </MemoryRouter>,
      );
      expect(screen.getByRole('link', { name: /continue to the ats/i })).toHaveAttribute('href', '/ats/requisitions/r-1?tab=pipeline');
      expect(replace).toHaveBeenCalledWith('/ats/requisitions/r-1?tab=pipeline');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
