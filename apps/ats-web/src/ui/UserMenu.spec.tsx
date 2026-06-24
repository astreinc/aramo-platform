import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { UserMenu } from './UserMenu';

// Aramo-Identity-Me-Endpoint-UserMenu-Directive-v1_0 — the top-right account
// menu. Presentational; the caller feeds resolved /me display data + the
// shared sign-out.

function renderMenu(props: Partial<Parameters<typeof UserMenu>[0]> = {}) {
  const onSignOut = vi.fn();
  render(
    <MemoryRouter>
      <UserMenu
        name="Purush Pichaimuthu"
        email="purush@astreinc.com"
        roleLine="Tenant Admin · Recruiter"
        onSignOut={onSignOut}
        settingsHref="/admin/settings/profile"
        {...props}
      />
    </MemoryRouter>,
  );
  return { onSignOut };
}

describe('UserMenu', () => {
  it('is collapsed until the trigger is clicked', () => {
    renderMenu();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', {
      name: 'Account: Purush Pichaimuthu',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows name, email, and the joined role line', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(screen.getByText('Purush Pichaimuthu')).toBeInTheDocument();
    expect(screen.getByText('purush@astreinc.com')).toBeInTheDocument();
    expect(screen.getByText('Tenant Admin · Recruiter')).toBeInTheDocument();
  });

  it('renders the Settings link to the profile route when a href is given', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/admin/settings/profile',
    );
  });

  it('omits the Settings link when no href is given (non-admin)', () => {
    renderMenu({ settingsHref: undefined });
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(
      screen.queryByRole('menuitem', { name: 'Settings' }),
    ).not.toBeInTheDocument();
    // Sign out is always available.
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('fires onSignOut and closes when Sign out is clicked', () => {
    const { onSignOut } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('omits the role line when there are no roles (no empty separator)', () => {
    renderMenu({ roleLine: null });
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    expect(screen.getByText('Purush Pichaimuthu')).toBeInTheDocument();
    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });

  it('is loading-safe: a neutral trigger with Sign out when no data yet', () => {
    renderMenu({ name: '', email: '', roleLine: null });
    // Neutral label while /me is in flight.
    const trigger = screen.getByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    // No identity block, but the menu still functions (sign out).
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });
});
