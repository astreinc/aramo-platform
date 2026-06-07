import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
  type ShellNavItem,
} from '@aramo/fe-foundation';
import { Navigate, Route, Routes } from 'react-router-dom';

import { LoginPage } from './routes/LoginPage';
import { RequisitionDetailView } from './requisitions/RequisitionDetailView';
import { RequisitionsListView } from './requisitions/RequisitionsListView';

// The recruiter nav. R1 ships a single surface — Requisitions. R2+
// adds Talent / Companies / Dashboard as the breadth lands.
const RECRUITER_NAV: readonly ShellNavItem[] = [
  {
    to: '/requisitions',
    label: 'Requisitions',
    requireScope: 'requisition:read',
  },
];

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
                  brand="Aramo · Recruiter Console"
                  navItems={RECRUITER_NAV}
                >
                  <Routes>
                    <Route
                      index
                      element={<Navigate to="/requisitions" replace />}
                    />
                    <Route
                      path="requisitions"
                      element={
                        <RouteGuard
                          requireScope="requisition:read"
                          sessionStateOverride={state}
                        >
                          <RequisitionsListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="requisitions/:reqId"
                      element={
                        <RouteGuard
                          requireScope="requisition:read"
                          sessionStateOverride={state}
                        >
                          <RequisitionDetailView />
                        </RouteGuard>
                      }
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
