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

  it('exposes the primary nav landmark and renders children', () => {
    renderShell(makeSession(['requisition:read']));
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});
