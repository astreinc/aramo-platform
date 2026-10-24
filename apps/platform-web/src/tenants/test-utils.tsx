import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider, type Session } from '@aramo/fe-foundation';

import { IdentityProvider } from '../identity/identity';
import type { PlatformMe } from '../platform-api';

// PLATFORM-UX-1 F-3..F-5 test helpers: a platform session with given scopes,
// and a render inside a router + toast provider + identity provider, with a
// probe that prints the current location (for navigation assertions).

export const ALL_TENANT_SCOPES = [
  'platform:tenant:read',
  'platform:tenant:provision',
  'platform:tenant:lifecycle:manage',
];
export const READ_ONLY_TENANT = ['platform:tenant:read'];

export function tenantSession(scopes: readonly string[]): Session {
  return {
    sub: '01900000-0000-7000-8000-0000000ac001',
    consumer_type: 'platform',
    tenant_id: '01900000-0000-7000-8000-000000000100',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  };
}

const ME: PlatformMe = {
  user_id: 'u1',
  email: 'maya.okafor@aramo.ai',
  display_name: 'Maya Okafor',
  tenant_id: 't0',
  tenant_name: 'Aramo Platform',
  role_keys: ['super_admin'],
};

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{`${loc.pathname}${loc.search}`}</output>;
}

export function renderAt(
  ui: ReactElement,
  { path, url, session }: { readonly path: string; readonly url: string; readonly session: Session },
) {
  return render(
    <ToastProvider>
      <IdentityProvider session={session} load={() => Promise.resolve(ME)}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="*" element={<span>elsewhere</span>} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </IdentityProvider>
    </ToastProvider>,
  );
}
