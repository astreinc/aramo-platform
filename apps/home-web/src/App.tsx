import { AUTH_PRODUCTS, RouteGuard, SignedOut, ToastProvider, useSession } from '@aramo/fe-foundation';
import { OrgAdminRoutes, hasOrgAdminScope } from '@aramo/org-admin-web';
import { Route, Routes } from 'react-router-dom';

import { AppHomeView } from './home/AppHomeView';
import { LegacyAtsRedirect } from './home/LegacyAtsRedirect';
import { PreferencesView } from './home/PreferencesView';
import { LoginPage } from './routes/LoginPage';
import { HomeShell } from './shell/HomeShell';

// D-ORG-2/3 — the Aramo App Home (apps/home-web): the permanent, product-neutral
// tenant entry on `<slug>.aramo.ai` (§3.A), topology T1 (§3.B):
//   /            App Home — the product tiles (backend-authoritative availability)
//   /preferences My preferences (shared account, default landing page)
//   /org/*       Organization Administration (libs/org-admin-web)
//   /login       the session-less login landing (?error=<CODE> pages)
//   /signed-out  the public signed-out landing (Cognito logout returns here)
//   *            a pre-T1 ATS bookmark (e.g. /talent/…) → forwarded to /ats<path>
// The ATS app is a SIBLING SPA served at /ats/ by nginx — never merged here.
export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* The PUBLIC signed-out landing — outside RouteGuard so it renders
            session-less and performs NO automatic authentication. */}
        <Route path="/signed-out" element={<SignedOut offerAccountSwitch product={AUTH_PRODUCTS.home} />} />
        <Route
          path="/"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <HomeShell session={state.session}>
                  <AppHomeView isOrgAdmin={hasOrgAdminScope(state.session)} />
                </HomeShell>
              ) : null}
            </RouteGuard>
          }
        />
        <Route
          path="/preferences"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <HomeShell session={state.session}>
                  <PreferencesView />
                </HomeShell>
              ) : null}
            </RouteGuard>
          }
        />
        <Route
          path="/org/*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <HomeShell session={state.session}>
                  <OrgAdminRoutes session={state.session} />
                </HomeShell>
              ) : null}
            </RouteGuard>
          }
        />
        {/* Bookmark compatibility (D-ORG-2): any other path on the tenant host is a
            pre-T1 ATS deep link. Forwarded BEFORE any session probe (no org login
            round-trip for an ATS bookmark); the ATS app then authenticates it. */}
        <Route path="*" element={<LegacyAtsRedirect />} />
      </Routes>
    </ToastProvider>
  );
}
