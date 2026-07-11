import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { RouteGuard, ToastProvider, useSession } from '@aramo/fe-foundation';

import { LoginPage } from './LoginPage';
import { PlatformShell } from './shell/PlatformShell';
import { TenantsListView } from './tenants/TenantsListView';
import { TenantDetailView } from './tenants/TenantDetailView';
import { ProvisionTenantView } from './tenants/ProvisionTenantView';

// The platform console app (Inc-2 PR-2). Single guarded surface: the whole thing
// requires platform:tenant:read. Unauthenticated → RouteGuard redirects to
// /auth/platform/login (the configured consumer). Authenticated-but-unscoped →
// fe-foundation ForbiddenState. Lifecycle actions additionally check
// platform:tenant:lifecycle:manage client-side for button visibility (the detail
// view) — server-side enforcement is authoritative.
export function App() {
  const state = useSession();
  const location = useLocation();

  // Inc-3 PR-3.5 (Workstream B) — /login is the SESSION-LESS landing the
  // auth-service callback navigates to on a login failure (?error=<CODE>). It
  // must render OUTSIDE RouteGuard (an unauthenticated user is exactly who lands
  // here) — otherwise RouteGuard would bounce them straight back to the IdP and
  // swallow the error. Short-circuit before the guard; same param/pattern as
  // ats-web.
  if (location.pathname === '/login') {
    return (
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <RouteGuard requireScope="platform:tenant:read" sessionStateOverride={state}>
        {state.status === 'authenticated' ? (
          <PlatformShell>
            <Routes>
              <Route path="/tenants" element={<TenantsListView />} />
              <Route path="/tenants/new" element={<ProvisionTenantView />} />
              <Route
                path="/tenants/:id"
                element={<TenantDetailView session={state.session} />}
              />
              <Route path="*" element={<Navigate to="/tenants" replace />} />
            </Routes>
          </PlatformShell>
        ) : null}
      </RouteGuard>
    </ToastProvider>
  );
}
