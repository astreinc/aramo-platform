import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgAdminRoutes } from '../OrgAdminRoutes';

// Organization administration routes (unified multi-product UX; accepted App
// Home handoff §7). OrgAdminRoutes is the single `tenant:admin:*` gate for every
// /org/* section; a member without it is sent to App Home with the denial
// notice BEFORE any organization screen renders.
function makeSession(scopes: readonly string[]): Session {
  return { sub: 'user-1', consumer_type: 'org', tenant_id: 'tenant-abc', scopes: [...scopes], iat: 0, exp: 0 };
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function renderAt(path: string, session: Session) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="org/*" element={<OrgAdminRoutes session={session} />} />
          <Route path="/" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

const ROSTER = {
  items: [
    { user_id: 'u-1', email: 'owner@acme.test', display_name: 'Olive Owner', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['tenant_owner'] },
    { user_id: 'u-2', email: 'rec@acme.test', display_name: 'Rae Recruiter', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['recruiter', 'esign_sender'] },
  ],
};
const CATALOG = {
  roles: [
    { key: 'tenant_owner', display: 'Tenant Owner', description: '', tier: 'Administration', scopes: ['tenant:admin:user-manage', 'talent:read'] },
    { key: 'recruiter', display: 'Recruiter', description: '', tier: 'Operations', scopes: ['talent:read'] },
    { key: 'esign_sender', display: 'Sign Sender', description: '', tier: 'E-Sign', scopes: ['esign:envelope:send'] },
  ],
};

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/v1/tenant/roles-catalog')) return okJson(CATALOG);
    if (url.startsWith('/v1/tenant/settings')) return okJson({ 'audit.financials_enabled': false });
    if (url.startsWith('/v1/tenant/users')) return okJson(ROSTER);
    return okJson({});
  });
}

describe('organization routes (/org/*)', () => {
  it('a member without an organization permission is sent to App Home with the denial notice — no organization screen renders', () => {
    renderAt('/org/users', makeSession(['talent:read']));
    expect(screen.getByTestId('where')).toHaveTextContent('/?notice=org-denied');
    expect(screen.queryByRole('navigation', { name: 'Organization sections' })).toBeNull();
    expect(screen.queryByText('Users & invitations')).toBeNull();
  });

  it('Users & invitations: Person · Organization · ATS · Sign columns derived from roles + catalog; invite present; no role editing', async () => {
    mockApi();
    renderAt('/org/users', makeSession(['tenant:admin:user-manage']));
    expect(await screen.findByRole('heading', { name: 'Users & invitations' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Olive Owner')).toBeInTheDocument());
    for (const h of ['Person', 'Organization', 'ATS', 'Sign']) expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.getByTestId('open-invite')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-roles-u-1')).toBeNull();
  });

  it('Users & product access: the existing role-assignment surface (Edit roles), no invite and no lifecycle actions', async () => {
    mockApi();
    renderAt('/org/roles', makeSession(['tenant:admin:user-manage']));
    expect(await screen.findByRole('heading', { name: 'Users & product access' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('edit-roles-u-1')).toBeInTheDocument());
    expect(screen.queryByTestId('open-invite')).toBeNull();
    expect(screen.queryByTestId('disable-u-1')).toBeNull();
  });

  it('the tab row lists the accepted sections in order; the index lands on Profile', () => {
    mockApi();
    renderAt('/org', makeSession(['tenant:admin:settings']));
    const tabs = screen.getByRole('navigation', { name: 'Organization sections' });
    expect([...tabs.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Profile',
      'Users & invitations',
      'Users & product access',
      'Sites',
      'Domain',
      'Settings',
      'Audit',
    ]);
    expect(screen.getByTestId('org-nav-users')).toHaveAttribute('href', '/org/users');
  });

  it('a valid return context shows "Back to ATS Settings" pointing at the exact originating page, kept across tabs', async () => {
    mockApi();
    renderAt(`/org/sites?from=ats&return=${encodeURIComponent('/ats/admin/settings/branches')}`, makeSession(['tenant:admin:sites']));
    const back = await screen.findByTestId('org-back-link');
    expect(back).toHaveTextContent('Back to ATS Settings');
    expect(back).toHaveAttribute('href', '/ats/admin/settings/branches');
  });

  it('an invalid or external return context is ignored (no Back link)', () => {
    mockApi();
    for (const bad of ['https://evil.example/x', '//evil.example', '/org/users', '/ats//x', '/ats/x y']) {
      window.sessionStorage.clear();
      const { unmount } = renderAt(`/org/profile?from=ats&return=${encodeURIComponent(bad)}`, makeSession(['tenant:admin:profile']));
      expect(screen.queryByTestId('org-back-link')).toBeNull();
      unmount();
    }
  });

  it('D-ORG paths fold into the accepted sections (security → domain, billing/localization → settings)', () => {
    mockApi();
    renderAt('/org/security', makeSession(['tenant:admin:domain']));
    expect(screen.getByTestId('org-nav-domain')).toHaveAttribute('aria-current', 'page');
  });
});
