import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  AppShell,
  Breadcrumb,
  CmdKSearch,
  NotificationButton,
  Rail,
  RailNavItem,
  RailUser,
  ShellBrand,
  TopBar,
} from './AppShell';

describe('Rail', () => {
  it('renders brand, nav items with counts, and the user footer', () => {
    render(
      <Rail brand="Aramo · Recruiter" user={<RailUser initials="PN" name="Priya Nair" role="Senior recruiter" />}>
        <RailNavItem label="Requisitions" count={12} active />
        <RailNavItem label="Talent" />
      </Rail>,
    );
    expect(screen.getByText('Aramo · Recruiter')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Senior recruiter')).toBeInTheDocument();
  });

  it('marks the active nav item with aria-current=page', () => {
    render(
      <Rail>
        <RailNavItem label="Requisitions" active />
        <RailNavItem label="Talent" />
      </Rail>,
    );
    expect(screen.getByRole('button', { name: /Requisitions/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Talent/ })).not.toHaveAttribute('aria-current');
  });

  it('invokes onActivate when a nav item is clicked', () => {
    const onActivate = vi.fn();
    render(
      <Rail>
        <RailNavItem label="Talent" onActivate={onActivate} />
      </Rail>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Talent' }));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});

describe('Breadcrumb', () => {
  it('marks the final crumb as the current page', () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          items={[
            { label: 'Requisitions', href: '/requisitions' },
            { label: 'Senior Rust Engineer' },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText('Senior Rust Engineer')).toHaveAttribute('aria-current', 'page');
  });
});

describe('CmdKSearch', () => {
  it('is keyboard-activatable (Enter)', () => {
    const onActivate = vi.fn();
    render(<CmdKSearch onActivate={onActivate} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Search/ }), { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledOnce();
  });
});

describe('NotificationButton', () => {
  it('announces the unread state', () => {
    render(<NotificationButton hasUnread />);
    expect(screen.getByRole('button', { name: 'Notifications (unread)' })).toBeInTheDocument();
  });
});

describe('AppShell', () => {
  it('composes rail, top bar, and content', () => {
    render(
      <AppShell rail={<Rail>{null}</Rail>} topBar={<TopBar>bar</TopBar>}>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
  });

  it('collapses / expands the rail via the edge toggle (aria-expanded + class + persistence)', () => {
    window.localStorage.removeItem('rc-rail-collapsed');
    const { container } = render(
      <AppShell rail={<Rail>{null}</Rail>} topBar={<TopBar>bar</TopBar>}>
        <p>content</p>
      </AppShell>,
    );
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.rc-app--rail-collapsed')).toBeNull();

    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Expand navigation' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.rc-app--rail-collapsed')).not.toBeNull();
    expect(window.localStorage.getItem('rc-rail-collapsed')).toBe('1');
  });

  it('ShellBrand renders the logo as a home link', () => {
    render(
      <MemoryRouter>
        <ShellBrand brand="Aramo · Recruiter" to="/" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Aramo · Recruiter')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Aramo · Recruiter — home/ }),
    ).toHaveAttribute('href', '/');
  });
});
