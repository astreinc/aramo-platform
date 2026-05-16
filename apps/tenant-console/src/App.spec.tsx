import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App';

describe('App smoke', () => {
  it('renders without crashing', () => {
    // Keep the session probe pending so useSession stays in `loading`.
    // RouteGuard's loading branch renders text and does not call
    // redirectToLogin, so jsdom's non-configurable window.location.assign
    // is never invoked. This exercises RouteGuard's loading seam without
    // monkey-patching window.location.
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => undefined));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/loading session/i)).toBeInTheDocument();
  });
});
