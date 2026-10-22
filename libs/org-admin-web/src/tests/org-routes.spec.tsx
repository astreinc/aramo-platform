import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgAdminRoutes } from '../OrgAdminRoutes';

// ORG-UX-1 (Directive v1.0 LOCKED §3, §4.3, §7.2; Lead Corrections A + C) — the
// Organization route tree. Access is the SERVER's org_access (GET /v1/me/products), never
// scope possession: admin = every section, templates = Our templates + gallery, none = App
// Home with the denial notice before any Organization screen renders.
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
    { user_id: 'u-2', email: 'rec@acme.test', display_name: 'Rae Recruiter', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['recruiter', 'sign_sender'] },
    { user_id: 'u-3', email: 'am@acme.test', display_name: 'Avi Manager', is_active: true, invite_status: 'ACTIVE', deactivated_at: null, site_id: null, role_keys: ['account_manager'] },
  ],
};
const CATALOG = {
  roles: [
    { key: 'tenant_owner', display: 'Tenant Owner', description: '', tier: 'Administration', scopes: ['tenant:admin:user-manage', 'talent:read'] },
    { key: 'recruiter', display: 'Recruiter', description: '', tier: 'Operations', scopes: ['talent:read'] },
    { key: 'account_manager', display: 'Account Manager', description: '', tier: 'Management', scopes: ['tenant:admin:user-manage', 'talent:read'] },
    { key: 'sign_sender', display: 'Sign Sender', description: '', tier: 'Sign', scopes: ['sign:envelope:send'] },
  ],
};

const SIGN = 'https://sign.aramo.ai';
function products(orgAccess: 'admin' | 'templates' | 'none') {
  return {
    tenant_id: 'tenant-abc',
    products: [
      { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
      { key: 'sign', subscribed: true, authorized: true, available: true, entry_path: `${SIGN}/`, reason: null },
      {
        key: 'org',
        subscribed: true,
        authorized: orgAccess !== 'none',
        available: orgAccess !== 'none',
        entry_path: orgAccess === 'admin' ? '/org/' : orgAccess === 'templates' ? '/org/document-templates' : null,
        reason: orgAccess === 'none' ? 'not_authorized' : null,
        org_access: orgAccess,
      },
    ],
  };
}

function mockApi(orgAccess: 'admin' | 'templates' | 'none' = 'admin') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/v1/me/products')) return okJson(products(orgAccess));
    if (url.startsWith('/v1/me')) return okJson({ user: { id: 'user-1', email: 'owner@acme.test', display_name: 'Olive Owner' }, tenant: { id: 'tenant-abc', display_name: 'Acme' }, roles: [] });
    if (url.startsWith('/v1/document-templates')) return okJson(url.includes('/library') ? { items: [] } : url.includes('/selections') ? { items: [] } : url.includes('/notices') ? { notices: [] } : []);
    if (url.startsWith('/v1/tenant/roles-catalog')) return okJson(CATALOG);
    if (url.startsWith('/v1/tenant/settings')) return okJson({ 'audit.financials_enabled': false });
    if (url.startsWith('/v1/tenant/users')) return okJson(ROSTER);
    if (url.startsWith('/v1/tenant/sites')) return okJson({ items: [] });
    if (url.startsWith('/v1/tenant/audit-events')) return okJson({ items: [], next_cursor: null });
    if (url.startsWith('/v1/tenant/domain-verification'))
      return okJson({ status: 'UNVERIFIED', allowed_domain: 'acme.test', record_name: null, record_value: null, verified_at: null, token_issued_at: null });
    if (url.startsWith('/v1/tenant/profile')) return okJson({ id: 't', name: 'Acme', legal_name: null, display_name: null, address_line1: null, address_line2: null, city: null, state_province: null, postal_code: null, country_code: null, tax_id: null, registration_number: null, primary_contact_name: null, primary_contact_email: null });
    return okJson({});
  });
}

describe('organization routes (/org/*)', () => {
  it('org_access none: sent to App Home with the denial notice — even with tenant:admin:* scopes (Correction A)', async () => {
    mockApi('none');
    renderAt('/org/users', makeSession(['tenant:admin:user-manage', 'tenant:admin:profile']));
    expect(await screen.findByTestId('where')).toHaveTextContent('/?notice=org-denied');
    expect(screen.queryByRole('heading', { name: 'Users & invitations' })).toBeNull();
  });

  it('org_access admin: /org lands on Overview; there are no horizontal section tabs', async () => {
    mockApi('admin');
    renderAt('/org', makeSession([]));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Organization sections' })).toBeNull();
  });

  it('org_access admin: Users & invitations and Roles & access render', async () => {
    mockApi('admin');
    const first = renderAt('/org/users', makeSession(['tenant:admin:user-manage']));
    expect(await screen.findByRole('heading', { name: 'Users & invitations' })).toBeInTheDocument();
    first.unmount();
    renderAt('/org/roles', makeSession(['tenant:admin:user-manage']));
    expect(await screen.findByRole('heading', { name: 'Roles & access' })).toBeInTheDocument();
  });

  it('org_access templates: /org lands on Our templates; organization pages are denied', async () => {
    mockApi('templates');
    const first = renderAt('/org', makeSession(['document_template:author', 'document_template:read']));
    expect(await screen.findByRole('heading', { name: 'Our templates' })).toBeInTheDocument();
    first.unmount();
    renderAt('/org/users', makeSession(['document_template:author']));
    expect(await screen.findByTestId('where')).toHaveTextContent('/?notice=org-denied');
  });

  it('a valid ATS return context shows "Back to ATS Settings" pointing at the exact originating page', async () => {
    mockApi('admin');
    renderAt(`/org/sites?from=ats&return=${encodeURIComponent('/ats/admin/settings/branches')}`, makeSession([]));
    const back = await screen.findByTestId('org-back-link');
    expect(back).toHaveTextContent('Back to ATS Settings');
    expect(back).toHaveAttribute('href', '/ats/admin/settings/branches');
  });

  it('a Sign return is accepted only on the trusted Sign origin inside /sign/settings/ (Correction C)', async () => {
    mockApi('admin');
    const ok = `${SIGN}/sign/settings/members`;
    const first = renderAt(`/org/roles?from=sign&return=${encodeURIComponent(ok)}`, makeSession([]));
    const back = await screen.findByTestId('org-back-link');
    expect(back).toHaveTextContent('Back to Sign Settings');
    expect(back).toHaveAttribute('href', ok);
    first.unmount();
    for (const bad of ['https://evil.example/sign/settings/members', `${SIGN}/sign/envelopes`]) {
      window.sessionStorage.clear();
      const { unmount } = renderAt(`/org/roles?from=sign&return=${encodeURIComponent(bad)}`, makeSession([]));
      await screen.findByRole('heading', { name: 'Roles & access' });
      expect(screen.queryByTestId('org-back-link')).toBeNull();
      unmount();
    }
  });

  it('an invalid or external ATS return context is ignored (no Back link)', async () => {
    mockApi('admin');
    for (const bad of ['https://evil.example/x', '//evil.example', '/org/users', '/ats//x', '/ats/x y']) {
      window.sessionStorage.clear();
      const { unmount } = renderAt(`/org/profile?from=ats&return=${encodeURIComponent(bad)}`, makeSession([]));
      await screen.findByRole('heading', { name: 'Profile' });
      expect(screen.queryByTestId('org-back-link')).toBeNull();
      unmount();
    }
  });

  it('D-ORG paths fold into the sections (security → Domain)', async () => {
    mockApi('admin');
    renderAt('/org/security', makeSession([]));
    expect(await screen.findByRole('heading', { name: 'Domain' })).toBeInTheDocument();
  });
});
