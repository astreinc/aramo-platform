import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AppRail, activeRailKey, type RailItem } from './AppRail';
import { AtsAppShell } from './AtsAppShell';
import { NAV_COLLAPSED_KEY, useCompactRailPage } from './nav-collapse';

const PRIMARY: RailItem[] = [
  { key: 'desk', to: '/', label: 'My desk' },
  { key: 'requisitions', to: '/requisitions', label: 'Requisitions', count: 2 },
  { key: 'placements', to: '/placements', label: 'Placements' },
  { key: 'talent', to: '/talent', label: 'Talent', count: 0 },
  { key: 'companies', to: '/companies', label: 'Companies' },
  { key: 'contacts', to: '/contacts', label: 'Contacts' },
];
const WORK: RailItem[] = [
  { key: 'sourcing', to: '/sourcing', label: 'Sourcing' },
  { key: 'tasks', to: '/tasks', label: 'Tasks' },
  { key: 'advisories', to: '/identity/advisories', label: 'Identity Advisories' },
  { key: 'disputes', to: '/identity/portal-disputes', label: 'Portal Disputes' },
  { key: 'proposals', to: '/trust/proposals', label: 'Trust Proposals' },
  { key: 'reports', to: '/reports', label: 'Reports' },
];
const ADMIN: RailItem[] = [{ key: 'settings', to: '/admin', label: 'Settings' }];

function CompactPage(): JSX.Element {
  useCompactRailPage();
  return <p>section-nav page</p>;
}

function mount(path = '/requisitions', page: JSX.Element = <p>page</p>): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AtsAppShell
        rail={<AppRail primary={PRIMARY} work={WORK} admin={ADMIN} userInitials="PP" userName="Purush P." tenantName="Astre Consulting" />}
        topBar={<header className="rc-topbar">top</header>}
      >
        {page}
      </AtsAppShell>
    </MemoryRouter>,
  );
}

const rail = (): HTMLElement => screen.getByRole('complementary', { name: 'Main navigation' });
const setWidth = (w: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
};

describe('AppRail — shared main nav (rail spec)', () => {
  afterEach(() => {
    localStorage.clear();
    setWidth(1440);
  });

  it('renders the items in spec order with WORK / ADMINISTRATION labels and a tenant footer', () => {
    mount();
    expect(within(rail()).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'My desk', 'Requisitions2', 'Placements', 'Talent', 'Companies', 'Contacts',
      'Sourcing', 'Tasks', 'Identity Advisories', 'Portal Disputes', 'Trust Proposals', 'Reports', 'Settings',
    ]);
    expect(within(rail()).getByText('Work')).toBeInTheDocument();
    expect(within(rail()).getByText('Administration')).toBeInTheDocument();
    expect(within(rail()).getByText('Astre Consulting')).toBeInTheDocument();
    // count badge omitted when 0; tooltip carries the count
    expect(within(rail()).getByRole('link', { name: 'Requisitions · 2' })).toHaveAttribute('title', 'Requisitions · 2');
    expect(within(rail()).getByRole('link', { name: 'Talent' })).toHaveAttribute('title', 'Talent');
  });

  it.each([
    ['/', 'desk'],
    ['/requisitions/r1', 'requisitions'],
    ['/requisitions/new', 'requisitions'],
    ['/requisitions/r1/talent/t1', 'requisitions'],
    ['/talent/t1/submittal/r1/workspace', 'requisitions'],
    ['/offer-start/p1', 'placements'],
    ['/talent/t1', 'talent'],
    ['/companies/c1', 'companies'],
    ['/identity/advisories', 'advisories'],
    ['/admin/settings/document-templates', 'settings'],
    ['/settings/me', 'settings'],
  ])('active item for %s is %s', (path, key) => {
    expect(activeRailKey(path)).toBe(key);
  });

  it('marks exactly one item aria-current=page (Talent × Requisition 360 → Requisitions)', () => {
    mount('/requisitions/r1/talent/t1');
    const current = within(rail()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('title'))).toEqual(['Requisitions · 2']);
  });

  it('collapse writes aramo.nav.collapsed; a fresh mount renders collapsed on first paint', () => {
    mount();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');
    const open = within(rail()).getByRole('button', { name: 'Open sidebar' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    // Collapsed: labels → dividers; items keep accessible names.
    expect(within(rail()).queryByText('Work')).toBeNull();
    expect(within(rail()).getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('reads the stored preference on mount (and migrates the legacy key)', () => {
    localStorage.setItem('rc-rail-collapsed', '1');
    mount();
    expect(within(rail()).getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');
  });

  it('⌘\\ / Ctrl+\\ toggles on every page with the same write-through', () => {
    mount();
    act(() => {
      fireEvent.keyDown(document, { key: '\\', ctrlKey: true });
    });
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');
    act(() => {
      fireEvent.keyDown(document, { key: '\\', metaKey: true });
    });
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('0');
  });

  it('section-nav page under 1280px opens collapsed regardless of the stored value; a toggle wins for the visit', () => {
    setWidth(1024);
    localStorage.setItem(NAV_COLLAPSED_KEY, '0');
    mount('/requisitions/r1/talent/t1', <CompactPage />);
    const open = within(rail()).getByRole('button', { name: 'Open sidebar' });
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('0'); // stored value untouched
    fireEvent.click(open);
    expect(within(rail()).getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('0');
  });

  it('section-nav page at 1280px+ uses the stored value', () => {
    setWidth(1440);
    localStorage.setItem(NAV_COLLAPSED_KEY, '0');
    mount('/requisitions/r1/talent/t1', <CompactPage />);
    expect(within(rail()).getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });
});
