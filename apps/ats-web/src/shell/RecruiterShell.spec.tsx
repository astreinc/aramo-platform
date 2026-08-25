import { apiClient, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('renders only the nav items the session is scoped for; Search is not a rail item', () => {
    renderShell(makeSession(['requisition:read', 'talent:read']));
    expect(screen.getByRole('link', { name: 'Requisitions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talent' })).toBeInTheDocument();
    // REQ-PIXEL-PARITY-1 — Search is no longer a rail nav item (it lives in the
    // top-bar ⌘K search). The /search route is unchanged; only the rail entry
    // is removed, matching the ratified Requisitions.dc.html rail.
    expect(screen.queryByRole('link', { name: 'Search' })).not.toBeInTheDocument();
    // Not held → not rendered.
    expect(screen.queryByRole('link', { name: 'My desk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  // T4-E / E1-d — the Placements nav entry follows placement:read (least-
  // visibility): visible to a placement-scoped principal, hidden otherwise.
  it('shows the Placements nav entry only to a placement:read principal', () => {
    renderShell(makeSession(['placement:read', 'requisition:read']));
    expect(screen.getByRole('link', { name: 'Placements' })).toHaveAttribute(
      'href',
      '/placements',
    );
  });

  it('hides the Placements nav entry from a principal without placement:read', () => {
    renderShell(makeSession(['requisition:read', 'talent:read']));
    expect(screen.queryByRole('link', { name: 'Placements' })).not.toBeInTheDocument();
  });

  it('hosts the aramo.ai brand as a rail home link (REQ-PIXEL-PARITY-1)', () => {
    renderShell(makeSession(['talent:read']));
    // Brand moved from the top bar to the rail top, matching Requisitions.dc.html.
    const brand = screen.getByRole('link', { name: /aramo\.ai — home/ });
    expect(brand).toHaveAttribute('href', '/');
    expect(brand).toHaveTextContent('aramo.ai');
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
    for (const label of ['My desk', 'Requisitions', 'Talent', 'Companies', 'Tasks']) {
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

  // Enterprise "one clear H1" ruling: the app shell no longer renders a
  // route/section title in the TopBar (it duplicated each page's own
  // H1/PageHeader, and the left rail already marks the active module). The
  // TopBar retains only global utilities (⌘K search, notifications, tenant/user
  // context, account controls). The per-view entity publication (useEntityCrumb)
  // is retained and covered by the detail-view specs; it simply no longer
  // renders in the shell.
  it('does not render a duplicated route/page title in the app shell', () => {
    renderShell(makeSession(['talent:read']), '/talent');
    expect(
      screen.queryByRole('navigation', { name: 'Breadcrumb' }),
    ).not.toBeInTheDocument();
    // The primary rail nav (active-module indicator) still communicates location.
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument();
  });

  // ── T10-B1/F-005 — Portal Disputes discoverable via the rail, gated on its
  //    EXISTING route scope (identity:resolve); hidden (no NavLink, no fetch)
  //    without it. ──
  it('surfaces the Portal Disputes nav item for an identity:resolve principal', () => {
    renderShell(makeSession(['identity:resolve']));
    expect(
      screen.getByRole('link', { name: 'Portal Disputes' }),
    ).toHaveAttribute('href', '/identity/portal-disputes');
  });

  it('hides the Portal Disputes nav item from a principal without identity:resolve', () => {
    renderShell(makeSession(['talent:read']));
    // Trust Proposals (talent:read) is shown, but Portal Disputes is not — and
    // because it is not rendered, no NavLink and no fetch originate from it.
    expect(screen.getByRole('link', { name: 'Trust Proposals' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Portal Disputes' }),
    ).not.toBeInTheDocument();
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

  // P2-A (REQ-PIXEL-PARITY-1-A2) — rail count pills from the truthful report
  // endpoints (NOT list length). Tasks has no substrate yet (P2-C).
  it('renders truthful Requisitions + Talent count pills (report:read)', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((async (path: string) => {
      if (path === '/v1/reports/requisition-rollup') {
        return { total: 18, by_status: {} };
      }
      if (path === '/v1/reports/tenant-counts') return { talent_records: 412 };
      return ME;
    }) as typeof apiClient.get);
    renderShell(makeSession(['requisition:read', 'talent:read', 'report:read']));
    const reqLink = await screen.findByRole('link', { name: /Requisitions/ });
    await waitFor(() =>
      expect(within(reqLink).getByText('18')).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('link', { name: /Talent/ })).getByText('412'),
    ).toBeInTheDocument();
  });

  it('fetches no counts without report:read (negative control)', async () => {
    const spy = vi.spyOn(apiClient, 'get').mockResolvedValue(ME);
    renderShell(makeSession(['requisition:read', 'talent:read']));
    await screen.findByRole('link', { name: /Requisitions/ });
    expect(spy).not.toHaveBeenCalledWith('/v1/reports/requisition-rollup');
    expect(spy).not.toHaveBeenCalledWith('/v1/reports/tenant-counts');
  });
});
