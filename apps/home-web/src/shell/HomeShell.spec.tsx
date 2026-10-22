import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductAvailabilityView } from '@aramo/fe-foundation';
import { SHARED_SETUP_HEADING } from '@aramo/org-admin-web';

import { HomeShell } from './HomeShell';

// ORG-UX-1 (Directive v1.0 LOCKED §1, §4.3, §7.1; handoff §2) — the main left nav is
// grouped PLATFORM · ORGANIZATION · SHARED SETUP and driven by the SERVER's org_access.
type Access = 'admin' | 'templates' | 'none';
function products(access: Access): ProductAvailabilityView {
  return {
    tenant_id: 't',
    products: [
      { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
      { key: 'sign', subscribed: false, authorized: false, available: false, entry_path: null, reason: 'not_subscribed' },
      {
        key: 'org',
        subscribed: true,
        authorized: access !== 'none',
        available: access !== 'none',
        entry_path: access === 'admin' ? '/org/' : access === 'templates' ? '/org/document-templates' : null,
        reason: access === 'none' ? 'not_authorized' : null,
        org_access: access,
      },
    ],
  } as ProductAvailabilityView;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ user: { display_name: 'Purush Pichaimuthu', email: 'p@acme.test' }, roles: [], tenant: { display_name: 'Astre Consulting', status: 'ACTIVE' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

function renderShell(access: Access | 'pending', path = '/') {
  const fetchProducts = access === 'pending' ? () => new Promise<ProductAvailabilityView>(() => undefined) : () => Promise.resolve(products(access));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HomeShell fetchProducts={fetchProducts}>
        <p>page</p>
      </HomeShell>
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole('complementary', { name: 'Main navigation' });
const navLabels = () => within(nav()).getAllByRole('link').map((a) => a.getAttribute('aria-label'));

describe('HomeShell — main nav by server org_access', () => {
  it('admin: PLATFORM · ORGANIZATION (6) · SHARED SETUP (4), in handoff order, production paths', async () => {
    renderShell('admin');
    expect(await within(nav()).findByTestId('org-nav-overview')).toHaveAttribute('href', '/org/overview');
    expect(within(nav()).getByText('Platform')).toBeInTheDocument();
    expect(within(nav()).getByText('Organization')).toBeInTheDocument();
    expect(within(nav()).getByText(SHARED_SETUP_HEADING)).toBeInTheDocument();
    expect(navLabels()).toEqual([
      'aramo.ai, go to App Home',
      'App Home',
      'Overview',
      'Profile',
      'Users & invitations',
      'Roles & access',
      'Sites',
      'Domain',
      'Settings',
      'Our templates',
      'Template gallery',
      'Audit',
    ]);
    expect(within(nav()).getByTestId('org-nav-templates')).toHaveAttribute('href', '/org/document-templates');
    expect(within(nav()).getByTestId('org-nav-gallery')).toHaveAttribute('href', '/org/document-templates/gallery');
    expect(within(nav()).queryByRole('link', { name: 'Organization' })).toBeNull();
  });

  it('templates: PLATFORM + SHARED SETUP with Our templates + Template gallery only', async () => {
    renderShell('templates');
    expect(await within(nav()).findByTestId('org-nav-templates')).toBeInTheDocument();
    expect(navLabels()).toEqual(['aramo.ai, go to App Home', 'App Home', 'Our templates', 'Template gallery']);
    expect(within(nav()).getByText(SHARED_SETUP_HEADING)).toBeInTheDocument();
    expect(within(nav()).queryByText('Organization')).toBeNull();
  });

  it('none: App Home only', async () => {
    renderShell('none');
    await screen.findByText('Astre Consulting', { selector: '.home-orgname' });
    expect(navLabels()).toEqual(['aramo.ai, go to App Home', 'App Home']);
    expect(within(nav()).queryByText(SHARED_SETUP_HEADING)).toBeNull();
  });

  it('while the availability read is pending the nav shows App Home only', () => {
    renderShell('pending');
    expect(navLabels()).toEqual(['aramo.ai, go to App Home', 'App Home']);
  });

  it('the current page is aria-current: App Home at /, the section on /org/* (nested paths too)', async () => {
    const { unmount } = renderShell('admin', '/');
    expect(await within(nav()).findByTestId('home-nav-home')).toHaveAttribute('aria-current', 'page');
    unmount();
    renderShell('admin', '/org/document-templates/gallery');
    expect(await within(nav()).findByTestId('org-nav-gallery')).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByTestId('org-nav-templates')).not.toHaveAttribute('aria-current');
    expect(within(nav()).getByTestId('home-nav-home')).not.toHaveAttribute('aria-current');
  });
});

describe('HomeShell — top bar', () => {
  it('breadcrumb Organization / {Section}; "Organization" links to Overview for admins', async () => {
    renderShell('admin', '/org/users');
    const crumb = screen.getByTestId('home-crumb');
    expect(crumb).toHaveTextContent('Organization / Users & invitations');
    expect(await within(crumb).findByRole('link', { name: 'Organization' })).toHaveAttribute('href', '/org/overview');
  });

  it('/org resolves to Overview in the breadcrumb', async () => {
    renderShell('admin', '/org');
    expect(screen.getByTestId('home-crumb')).toHaveTextContent('Organization / Overview');
  });

  it('a template author sees the crumb without an Overview link', async () => {
    renderShell('templates', '/org/document-templates');
    await within(nav()).findByTestId('org-nav-templates');
    const crumb = screen.getByTestId('home-crumb');
    expect(crumb).toHaveTextContent('Organization / Our templates');
    expect(within(crumb).queryByRole('link')).toBeNull();
  });

  it('App Home and My preferences titles', () => {
    const { unmount } = renderShell('none', '/');
    expect(screen.getByTestId('home-crumb')).toHaveTextContent('App Home');
    unmount();
    renderShell('none', '/preferences');
    expect(screen.getByTestId('home-crumb')).toHaveTextContent('My preferences');
  });

  it.each([
    ['admin', 'ADMIN'],
    ['templates', 'MEMBER'],
  ] as const)('account menu role badge for org_access %s is %s', async (access, badge) => {
    renderShell(access);
    await within(nav()).findByTestId(access === 'admin' ? 'org-nav-overview' : 'org-nav-templates');
    fireEvent.pointerDown(screen.getByRole('button', { name: /Account/ }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(await screen.findByText(badge, { exact: true })).toBeInTheDocument();
  });
});
