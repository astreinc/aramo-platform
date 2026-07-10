import { apiClient, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecruiterShell } from './RecruiterShell';

function makeSession(scopes: readonly string[]): Session {
  return {
    sub: 'user-1',
    consumer_type: 'recruiter',
    tenant_id: 'tenant-abc',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  };
}

function renderShell(
  session: Session,
  path = '/requisitions',
  onLogoutComplete?: () => void,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RecruiterShell session={session} onLogoutComplete={onLogoutComplete}>
        <p>page content</p>
      </RecruiterShell>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('RecruiterShell', () => {
  it('renders only the nav items the session is scoped for (+ always-on Search)', () => {
    renderShell(makeSession(['requisition:read', 'talent:read']));
    expect(screen.getByRole('link', { name: 'Requisitions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search' })).toBeInTheDocument();
    // Not held → not rendered.
    expect(screen.queryByRole('link', { name: 'My desk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('hosts the unified "Aramo" brand in the top bar as a home link (no tier label)', () => {
    renderShell(makeSession(['talent:read']));
    const brand = screen.getByRole('link', { name: /Aramo — home/ });
    expect(brand).toHaveAttribute('href', '/');
    // The "· Recruiter" tier label is dropped post-consolidation.
    expect(brand).not.toHaveTextContent('Recruiter');
    expect(screen.getByText('Talent Intelligence')).toBeInTheDocument();
  });

  it('shows the admin nav section only to a tenant:admin-scoped principal', () => {
    renderShell(makeSession(['talent:read', 'tenant:admin:settings']));
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('hides the admin nav from a non-admin (recruiter-only) principal', () => {
    renderShell(makeSession(['requisition:read', 'talent:read', 'company:read', 'task:read']));
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('shows the full nav when all scopes are held', () => {
    renderShell(
      makeSession([
        'dashboard:read',
        'requisition:read',
        'talent:read',
        'company:read',
        'task:read',
      ]),
      '/',
    );
    for (const label of ['My desk', 'Requisitions', 'Talent', 'Companies', 'Search', 'Tasks']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active route with aria-current=page', () => {
    renderShell(makeSession(['requisition:read', 'talent:read']), '/requisitions');
    expect(screen.getByRole('link', { name: 'Requisitions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Talent' })).not.toHaveAttribute('aria-current');
  });

  it('renders a section breadcrumb for the current route', () => {
    renderShell(makeSession(['talent:read']), '/talent');
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb.textContent).toContain('Talent');
  });

  it('logs out via POST /logout then runs the completion seam', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined);
    const onLogoutComplete = vi.fn();
    renderShell(makeSession(['requisition:read']), '/requisitions', onLogoutComplete);
    fireEvent.click(screen.getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(onLogoutComplete).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith('/auth/recruiter/logout');
  });

  it('still completes logout when the POST fails (same outcome)', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('network'));
    const onLogoutComplete = vi.fn();
    renderShell(makeSession(['requisition:read']), '/requisitions', onLogoutComplete);
    fireEvent.click(screen.getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(onLogoutComplete).toHaveBeenCalledOnce());
  });

  // §5 D3 §C/§E — BOTH consumers: the recruiter surface AND the admin surface
  // ride this one shell + one shared session, so the enhanced (SSO-terminating)
  // logout must behave identically on an admin route. Same POST /logout local
  // clear; the completion seam then navigates to the Cognito hosted-UI /logout.
  it('drives the SAME shared SSO logout from the admin surface (both consumers)', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined);
    const onLogoutComplete = vi.fn();
    renderShell(
      makeSession(['talent:read', 'tenant:admin:settings']),
      '/admin/settings',
      onLogoutComplete,
    );
    // The admin nav is visible (proves we're on the admin surface)…
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    // …and the one logout control still terminates the shared session.
    fireEvent.click(screen.getByRole('button', { name: /Log out/ }));
    await waitFor(() => expect(onLogoutComplete).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith('/auth/recruiter/logout');
  });

  it('exposes the primary nav landmark and renders children', () => {
    renderShell(makeSession(['requisition:read']));
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  // Aramo-Identity-Me-Endpoint-UserMenu — the shell fetches /me and feeds the
  // org label, the top-right user menu, and the rail footer from it (replacing
  // the old hardcoded "Recruiter" consumer_type label).
  const ME = {
    user: { display_name: 'Purush Pichaimuthu', email: 'purush@astreinc.com' },
    roles: ['Tenant Admin', 'Recruiter'],
    tenant: { display_name: 'Astre Consulting Services Inc', status: 'ACTIVE' },
  };

  it('renders the tenant org label and real rail identity from /me', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(ME);
    renderShell(makeSession(['talent:read', 'tenant:admin:settings']));
    // Org-context label (M365 text, not a logo).
    expect(
      await screen.findByText('Astre Consulting Services Inc'),
    ).toBeInTheDocument();
    // Rail footer now shows the real name + joined role line — NOT "Recruiter".
    expect(screen.getByText('Purush Pichaimuthu')).toBeInTheDocument();
    expect(screen.getByText('Tenant Admin · Recruiter')).toBeInTheDocument();
  });

  it('surfaces name, email, and role line in the top-right user menu', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(ME);
    renderShell(makeSession(['talent:read', 'tenant:admin:settings']));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Account: Purush Pichaimuthu' }),
    );
    expect(screen.getByText('purush@astreinc.com')).toBeInTheDocument();
    // Admin → the Settings link to the profile route is present.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/admin/settings/profile',
    );
  });

  it('hides the user-menu Settings link from a non-admin principal', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      ...ME,
      roles: ['Recruiter'],
    });
    renderShell(makeSession(['requisition:read', 'talent:read']));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Account: Purush Pichaimuthu' }),
    );
    expect(
      screen.queryByRole('menuitem', { name: 'Settings' }),
    ).not.toBeInTheDocument();
  });

  it('is loading-safe: chrome renders intact when /me fails', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    renderShell(makeSession(['requisition:read']));
    // Chrome intact: nav landmark + a neutral account trigger, no crash.
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Account menu' }),
    ).toBeInTheDocument();
    // No org label until /me resolves.
    expect(
      screen.queryByText('Astre Consulting Services Inc'),
    ).not.toBeInTheDocument();
  });

  // Inc-3 PR-3.5 (Workstream C) — the OFFBOARDING winding-down banner.
  const OFFBOARDING_COPY = /this workspace is winding down/i;

  it('renders the OFFBOARDING banner when /me reports an offboarding tenant', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      ...ME,
      tenant: { display_name: 'Astre Consulting Services Inc', status: 'OFFBOARDING' },
    });
    renderShell(makeSession(['requisition:read']));
    expect(await screen.findByText(OFFBOARDING_COPY)).toBeInTheDocument();
  });

  it('renders NO banner for an ACTIVE tenant', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(ME); // status: ACTIVE
    renderShell(makeSession(['requisition:read']));
    // Wait for /me to resolve (org label appears) before asserting absence.
    await screen.findByText('Astre Consulting Services Inc');
    expect(screen.queryByText(OFFBOARDING_COPY)).not.toBeInTheDocument();
  });
});
