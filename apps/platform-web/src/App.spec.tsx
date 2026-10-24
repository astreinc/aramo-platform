import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { platformSession } from './skills/test-session';

// PLATFORM-UX-1 F-2 (directive R-5) — access denied is an IN-SHELL state for the
// console entry gate and every per-route gate: it shows the signed-in identity
// and both account buttons, and never redirects on its own.

const ME = {
  user_id: 'u1',
  email: 'dev.raman@aramo.ai',
  display_name: 'Dev Raman',
  tenant_id: 't1',
  tenant_name: 'Aramo Platform',
  role_keys: ['read_only_auditor'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('App — in-shell access denied', () => {
  let assign: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const realLocation = window.location;

  function mockApi(scopes: string[], me: 'ok' | 'refused' = 'ok') {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/platform/session')) return json(platformSession(scopes));
      if (url.includes('/platform/me')) {
        return me === 'ok' ? json(ME) : json({ error: { code: 'INSUFFICIENT_SCOPE', message: 'no' } }, 403);
      }
      return json({}, 404);
    });
  }

  function renderAt(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  const meCalls = () => fetchSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/platform/me')).length;

  beforeEach(() => {
    configureAuthConsumer('platform');
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign, pathname: '/', search: '', hash: '', origin: 'http://localhost' },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    configureAuthConsumer('recruiter');
  });

  it('renders the entry gate inside the shell with the session fallback identity and no redirect', async () => {
    mockApi([]);
    renderAt('/');
    const denied = await screen.findByTestId('access-denied');
    const s = platformSession([]);
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent(
      "This account can't open Platform administration",
    );
    expect(within(denied).getByText(s.sub)).toBeInTheDocument();
    expect(within(denied).getByText(s.tenant_id)).toBeInTheDocument();
    expect(within(denied).getByText('View tenants')).toBeInTheDocument();
    expect(within(denied).getByText('platform:tenant:read')).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Sign in with a different account' })).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(denied).queryByRole('button', { name: 'Back to dashboard' })).toBeNull();
    // inside the shell: the environment bar and the breadcrumb are present
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent(`Signed in as ${s.sub} · ${s.tenant_id}`);
    expect(screen.getByRole('main')).toContainElement(denied);
    // never redirects on its own; /platform/me is not even asked
    expect(assign).not.toHaveBeenCalled();
    expect(meCalls()).toBe(0);

    fireEvent.click(within(denied).getByRole('button', { name: 'Sign in with a different account' }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain('/auth/platform/login?select_account=1');
  });

  it('renders a per-route gate inside the shell with the resolved identity and Back to dashboard', async () => {
    mockApi(['platform:tenant:read']);
    renderAt('/skills');
    const denied = await screen.findByTestId('access-denied');
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent("This account can't open Registry");
    expect(within(denied).getByText('View skills')).toBeInTheDocument();
    expect(within(denied).getByText('platform:skill:read')).toBeInTheDocument();
    await waitFor(() => expect(within(denied).getByText('dev.raman@aramo.ai')).toBeInTheDocument());
    expect(within(denied).getByText('Aramo Platform')).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Back to dashboard' })).toBeInTheDocument();
    expect(within(denied).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the session fallback when /platform/me is refused', async () => {
    mockApi(['platform:tenant:read'], 'refused');
    renderAt('/matching');
    const denied = await screen.findByTestId('access-denied');
    await waitFor(() => expect(meCalls()).toBe(1));
    const s = platformSession(['platform:tenant:read']);
    await waitFor(() => expect(within(denied).getByText(s.sub)).toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it('gates /admins on platform:admin:invite', async () => {
    mockApi(['platform:tenant:read']);
    renderAt('/admins');
    expect(await screen.findByTestId('access-denied')).toHaveTextContent("This account can't open Platform admins");
  });

  it('opens /admins with platform:admin:invite', async () => {
    mockApi(['platform:tenant:read', 'platform:admin:invite']);
    renderAt('/admins');
    expect(await screen.findByRole('heading', { name: 'Platform admins' })).toBeInTheDocument();
    expect(screen.queryByTestId('access-denied')).toBeNull();
  });
});
