import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformMe } from '../platform-api';
import { platformSession } from '../skills/test-session';

import { PlatformShell } from './PlatformShell';
import { useEntityCrumb } from './crumbs';
import { crumbsFor, navKeyFor, visibleNavGroups } from './nav';
import type { PaletteSources } from './CommandPalette';

const ALL = [
  'platform:tenant:read',
  'platform:tenant:provision',
  'platform:tenant:lifecycle:manage',
  'platform:admin:invite',
  'platform:skill:read',
  'platform:skill:manage',
  'platform:document_template:read',
  'platform:document_template:manage',
  'platform:matching_policy:read',
  'platform:matching_policy:write',
];

const ME: PlatformMe = {
  user_id: 'u1',
  email: 'maya.okafor@aramo.ai',
  display_name: 'Maya Okafor',
  tenant_id: 't1',
  tenant_name: 'Aramo Platform',
  role_keys: ['super_admin'],
};

const NO_DATA: PaletteSources = {
  loadTenants: () => Promise.resolve([]),
  loadSkills: () => Promise.resolve([]),
  loadTemplates: () => Promise.resolve([]),
};

function renderShell({
  scopes = ALL,
  path = '/',
  loadMe = () => Promise.resolve(ME),
  children = <p>page</p>,
  paletteSources = NO_DATA,
}: {
  scopes?: string[];
  path?: string;
  loadMe?: () => Promise<PlatformMe>;
  children?: React.ReactNode;
  paletteSources?: PaletteSources;
} = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PlatformShell session={platformSession(scopes)} loadMe={loadMe} paletteSources={paletteSources}>
        {children}
      </PlatformShell>
    </MemoryRouter>,
  );
}

const railNav = () => screen.getByRole('navigation', { name: 'Primary' });

describe('PlatformShell — permission-filtered rail (handoff §2, §3.3)', () => {
  it('shows every group and item to a super admin, in the design order', async () => {
    renderShell();
    const nav = railNav();
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('title'));
    expect(labels).toEqual([
      'Dashboard',
      'Tenants',
      'Review queue',
      'Pilot invites',
      'Abuse reports',
      'Registry',
      'Review queue',
      'Proposals',
      'Matching policy',
      'Document templates',
      'Template variables',
      'Platform admins',
    ]);
    expect(within(nav).getByRole('link', { name: 'Platform admins' })).toHaveAttribute('href', '/admins');
    await screen.findByText('Maya Okafor');
  });

  it('hides items without their permission and hides groups that become empty', async () => {
    renderShell({ scopes: ['platform:tenant:read', 'platform:skill:read'] });
    const nav = railNav();
    expect(within(nav).getByText('Operations')).toBeInTheDocument();
    expect(within(nav).getByText('Skills')).toBeInTheDocument();
    for (const gone of ['Sign Personal', 'Matching', 'Documents', 'Platform']) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
    expect(within(nav).queryByRole('link', { name: 'Pilot invites' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Platform admins' })).toBeNull();
    await screen.findByText('Maya Okafor');
  });

  it('gates Sign Personal on lifecycle:manage and Platform admins on admin:invite', async () => {
    renderShell({ scopes: ['platform:tenant:read', 'platform:tenant:lifecycle:manage', 'platform:admin:invite'] });
    const nav = railNav();
    expect(within(nav).getByRole('link', { name: 'Review queue' })).toHaveAttribute('href', '/personal-review');
    expect(within(nav).getByRole('link', { name: 'Pilot invites' })).toBeInTheDocument();
    // M-A7 §5.2 — the abuse-report queue (every sender), same scope.
    expect(within(nav).getByRole('link', { name: 'Abuse reports' })).toHaveAttribute('href', '/sign-abuse-reports');
    expect(within(nav).getByRole('link', { name: 'Platform admins' })).toBeInTheDocument();
    await screen.findByText('Maya Okafor');
  });

  it('highlights the list item on detail routes (aria-current="page")', async () => {
    renderShell({ path: '/skills/sk_123' });
    const current = within(railNav())
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('title'))).toEqual(['Registry']);
    await screen.findByText('Maya Okafor');
  });

  it('shows the PLATFORM tag and the footer identity', async () => {
    renderShell();
    expect(within(railNav()).getByText('PLATFORM')).toBeInTheDocument();
    expect(await screen.findByText('Super admin · Aramo Platform')).toBeInTheDocument();
  });
});

describe('PlatformShell — nav model', () => {
  it('maps paths to their nav item', () => {
    expect(navKeyFor('/')).toBe('dashboard');
    expect(navKeyFor('/tenants/new')).toBe('tenants');
    expect(navKeyFor('/tenants/tn_1')).toBe('tenants');
    expect(navKeyFor('/skills')).toBe('skills');
    expect(navKeyFor('/skills/review-queue')).toBe('skillQueue');
    expect(navKeyFor('/skills/proposals/pp_1')).toBe('proposals');
    expect(navKeyFor('/document-templates/dt_1')).toBe('templates');
    expect(navKeyFor('/admins')).toBe('admins');
  });

  it('builds crumbs that end in the entity name', () => {
    expect(crumbsFor('/', null)).toEqual([{ label: 'Operations' }, { label: 'Dashboard' }]);
    expect(crumbsFor('/tenants/tn_1', 'Northwind Logistics')).toEqual([
      { label: 'Operations' },
      { label: 'Tenants', to: '/tenants' },
      { label: 'Northwind Logistics' },
    ]);
    expect(crumbsFor('/tenants/tn_1', null)[2]).toEqual({ label: 'Tenant' });
    expect(crumbsFor('/tenants/new', 'ignored')[2]).toEqual({ label: 'Provision tenant' });
    expect(crumbsFor('/skills/review-queue', null)).toEqual([{ label: 'Skills' }, { label: 'Review queue' }]);
    expect(crumbsFor('/admins', null)).toEqual([{ label: 'Platform' }, { label: 'Platform admins' }]);
  });

  it('drops empty groups', () => {
    expect(visibleNavGroups(() => false)).toEqual([]);
  });
});

describe('PlatformShell — top bar (handoff §3.4)', () => {
  function NamedPage() {
    useEntityCrumb('Northwind Logistics');
    return <p>detail</p>;
  }

  it('ends the breadcrumb in the entity name a page sets', async () => {
    renderShell({ path: '/tenants/tn_1', children: <NamedPage /> });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs).toHaveTextContent('Operations/Tenants/Northwind Logistics');
    expect(within(crumbs).getByRole('link', { name: 'Tenants' })).toHaveAttribute('href', '/tenants');
    expect(within(crumbs).getByText('Northwind Logistics')).toHaveAttribute('aria-current', 'page');
    await screen.findByText('Maya Okafor');
  });

  it('opens the account menu with identity, account switch and sign out', async () => {
    renderShell();
    await screen.findByText('Maya Okafor');
    fireEvent.click(screen.getByRole('button', { name: 'Account: Maya Okafor, MO' }));
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(menu).toHaveTextContent('maya.okafor@aramo.ai');
    expect(menu).toHaveTextContent('SUPER ADMIN');
    expect(menu).toHaveTextContent('Aramo Platform');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Sign in with a different account',
      'Sign out',
    ]);
  });

  it('opens the ⌘K palette with grouped results and degrades when a source fails', async () => {
    const sources: PaletteSources = {
      loadTenants: () => Promise.resolve([{ id: 'tn_1', name: 'Northwind Logistics', slug: 'northwind', status: 'ACTIVE' }]),
      loadSkills: () => Promise.reject(new Error('403')),
      loadTemplates: vi.fn(() => Promise.resolve([])),
    };
    renderShell({ scopes: ['platform:tenant:read', 'platform:skill:read'], paletteSources: sources });
    await screen.findByText('Maya Okafor');
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Search' });
    const options = await within(dialog).findAllByRole('option');
    await waitFor(() => expect(within(dialog).getByText('Northwind Logistics')).toBeInTheDocument());
    expect(within(dialog).getAllByRole('option')[0]).toHaveTextContent('TenantNorthwind LogisticsnorthwindActive');
    expect(options.some((o) => o.textContent?.startsWith('Page'))).toBe(true);
    // no template read without the scope
    expect(sources.loadTemplates).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search' }), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('No matches.')).toBeInTheDocument();
  });

  it('opens the palette from the trigger', async () => {
    renderShell();
    await screen.findByText('Maya Okafor');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search tenants, skills, templates ⌘K' }));
    });
    expect(screen.getByRole('dialog', { name: 'Search' })).toHaveTextContent('↵ opens the first result');
  });
});

describe('PlatformShell — environment bar identity (directive R-6)', () => {
  it('shows email · tenant · role from /platform/me', async () => {
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId('envbar-identity')).toHaveTextContent(
        'Signed in as maya.okafor@aramo.ai · Aramo Platform · Super admin',
      ),
    );
  });

  it('falls back to the session sub and tenant id while loading', () => {
    renderShell({ loadMe: () => new Promise(() => undefined) });
    const s = platformSession(ALL);
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent(`Signed in as ${s.sub} · ${s.tenant_id}`);
  });

  it('falls back to the session sub and tenant id when /platform/me fails', async () => {
    const loadMe = vi.fn(() => Promise.reject(new Error('500')));
    renderShell({ loadMe });
    const s = platformSession(ALL);
    await waitFor(() => expect(loadMe).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent(`Signed in as ${s.sub} · ${s.tenant_id}`);
    expect(screen.getByTestId('envbar-identity').textContent).not.toContain('Super admin');
  });

  it('switches the context line inside the Studio (/document-templates/:id)', async () => {
    renderShell({ path: '/document-templates/dt_1' });
    expect(screen.getByText('Template changes apply to every tenant that uses the default')).toBeInTheDocument();
    await screen.findByText('Maya Okafor');
  });

  it('does not call /platform/me without platform:tenant:read', () => {
    const loadMe = vi.fn(() => Promise.resolve(ME));
    renderShell({ scopes: [], loadMe });
    expect(loadMe).not.toHaveBeenCalled();
    expect(screen.getByTestId('envbar-identity')).toHaveTextContent('Signed in as');
  });
});

describe('Template Studio route (handoff §10.2)', () => {
  it('drops the shell top bar and marks the shell full-bleed on /document-templates/:id', async () => {
    const { container } = renderShell({ path: '/document-templates/t1' });
    await waitFor(() => expect(container.querySelector('.pw-shell--studio')).not.toBeNull());
    expect(container.querySelector('.pw-crumbs')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search tenants, skills, templates ⌘K' })).toBeNull();
  });

  it('keeps the shell top bar on the template library, with the Studio file frame', async () => {
    const { container } = renderShell({ path: '/document-templates' });
    await waitFor(() => expect(container.querySelector('.pw-crumbs')).not.toBeNull());
    expect(container.querySelector('.pw-shell--studio')).toBeNull();
    expect(container.querySelector('.pw-shell--library')).not.toBeNull();
    expect(screen.getByText('Template changes apply to every tenant that uses the default')).toBeInTheDocument();
  });
});
