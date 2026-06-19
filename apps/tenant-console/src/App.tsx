import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
} from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';

// FE Consolidation COMPLETE (Directive 5): all six admin modules — settings,
// users, org, teams, assignments, consent — have ported to ats-web's /admin
// section. tenant-console is now a hollow shell (login + landing only) and is
// retired as a separate deployable in Directive 5 PR4. No nav items remain.

export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <Shell
                  session={state.session}
                  brand="Aramo · Tenant Console"
                  navItems={[]}
                >
                  <Routes>
                    <Route
                      index
                      element={<LandingPage session={state.session} />}
                    />
                  </Routes>
                </Shell>
              ) : null}
            </RouteGuard>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
