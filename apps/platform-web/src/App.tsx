import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  ForbiddenState,
  RouteGuard,
  SignedOut,
  ToastProvider,
  hasScope,
  useSession,
} from '@aramo/fe-foundation';

import { LoginPage } from './LoginPage';
import { PlatformShell } from './shell/PlatformShell';
import { DashboardView } from './dashboard/DashboardView';
import { TenantsListView } from './tenants/TenantsListView';
import { TenantDetailView } from './tenants/TenantDetailView';
import { ProvisionTenantView } from './tenants/ProvisionTenantView';
import { SkillsRegistryView } from './skills/SkillsRegistryView';
import { SkillDetailView } from './skills/SkillDetailView';
import { ReviewQueueView } from './skills/ReviewQueueView';
import { ProposalsListView } from './skills/ProposalsListView';
import { ProposalDetailView } from './skills/ProposalDetailView';

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

  // T2-E1-HF3 — the PUBLIC signed-out landing. Same short-circuit-before-guard
  // pattern as /login: the Cognito logout returns the browser here
  // (deriveSignoutRedirect → /signed-out); it must render session-less and NOT
  // re-enter RouteGuard (which would silently re-authenticate via SSO).
  if (location.pathname === '/signed-out') {
    return (
      <ToastProvider>
        <SignedOut />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <RouteGuard requireScope="platform:tenant:read" sessionStateOverride={state}>
        {state.status === 'authenticated' ? (
          <PlatformShell>
            <Routes>
              {/* Inc-3 PR-3.8 — the operator dashboard is the default post-login
                  screen; the tenant list is one click away in the rail. */}
              <Route path="/" element={<DashboardView />} />
              <Route path="/tenants" element={<TenantsListView />} />
              <Route path="/tenants/new" element={<ProvisionTenantView />} />
              <Route
                path="/tenants/:id"
                element={<TenantDetailView session={state.session} />}
              />
              {/* SKILL-TAX-1F-C1 — the platform skill governance console. Reachable
                  within the platform tier (app-level platform:tenant:read gate) and
                  additionally gated on platform:skill:read; a platform operator
                  without the skill scope sees a ForbiddenState rather than a page
                  that would only 403 at the API. Manage controls gate on
                  platform:skill:manage inside the views. */}
              <Route
                path="/skills"
                element={
                  hasScope(state.session, 'platform:skill:read') ? (
                    <SkillsRegistryView session={state.session} />
                  ) : (
                    <ForbiddenState scope="platform:skill:read" />
                  )
                }
              />
              {/* SKILL-TAX-1F-C2 — Review Queue + Proposals. Static paths precede
                  /skills/:id so react-router ranks them ahead of the dynamic detail
                  route. Same platform:skill:read gate. */}
              <Route
                path="/skills/review-queue"
                element={
                  hasScope(state.session, 'platform:skill:read') ? (
                    <ReviewQueueView session={state.session} />
                  ) : (
                    <ForbiddenState scope="platform:skill:read" />
                  )
                }
              />
              <Route
                path="/skills/proposals"
                element={
                  hasScope(state.session, 'platform:skill:read') ? (
                    <ProposalsListView />
                  ) : (
                    <ForbiddenState scope="platform:skill:read" />
                  )
                }
              />
              <Route
                path="/skills/proposals/:id"
                element={
                  hasScope(state.session, 'platform:skill:read') ? (
                    <ProposalDetailView session={state.session} />
                  ) : (
                    <ForbiddenState scope="platform:skill:read" />
                  )
                }
              />
              <Route
                path="/skills/:id"
                element={
                  hasScope(state.session, 'platform:skill:read') ? (
                    <SkillDetailView session={state.session} />
                  ) : (
                    <ForbiddenState scope="platform:skill:read" />
                  )
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </PlatformShell>
        ) : null}
      </RouteGuard>
    </ToastProvider>
  );
}
