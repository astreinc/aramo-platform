import { Navigate, Route, Routes } from 'react-router-dom';
import { RouteGuard, ToastProvider, useSession } from '@aramo/fe-foundation';

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
