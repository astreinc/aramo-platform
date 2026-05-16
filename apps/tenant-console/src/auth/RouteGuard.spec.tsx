import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RouteGuard } from './RouteGuard';
import type { Session } from './session';

const fakeSession: Session = {
  sub: '00000000-0000-0000-0000-000000000001',
  consumer_type: 'recruiter',
  tenant_id: '00000000-0000-0000-0000-000000000002',
  scopes: ['session:read'],
  iat: 0,
  exp: 0,
};

describe('RouteGuard', () => {
  it('renders children when session is authenticated', () => {
    render(
      <RouteGuard
        sessionStateOverride={{
          status: 'authenticated',
          session: fakeSession,
        }}
      >
        <p>protected content</p>
      </RouteGuard>,
    );

    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  it('triggers redirect when session is unauthenticated', () => {
    const onRedirect = vi.fn();

    render(
      <RouteGuard
        sessionStateOverride={{ status: 'unauthenticated' }}
        onRedirect={onRedirect}
      >
        <p>protected content</p>
      </RouteGuard>,
    );

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('renders loading state while session is resolving', () => {
    render(
      <RouteGuard sessionStateOverride={{ status: 'loading' }}>
        <p>protected content</p>
      </RouteGuard>,
    );

    expect(screen.getByText(/loading session/i)).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });
});
