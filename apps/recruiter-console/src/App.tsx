import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
} from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

// Recruiter R0 — the scaffold. Consumes @aramo/fe-foundation (the
// extracted Shell + RouteGuard + Session + ToastProvider). The
// placeholder route renders inside Shell so the lib's second-consumer
// integration is exercised at build. R1 will fill in the first-usable
// recruiter slice (login → my open reqs → kanban → transition → note).

function PlaceholderLanding() {
  return (
    <div>
      <h1>Aramo Recruiter Console</h1>
      <p>R0 scaffold — the recruiter slice ships in R1.</p>
    </div>
  );
}

export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route
          path="/*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <Shell
                  session={state.session}
                  brand="Aramo · Recruiter Console"
                >
                  <Routes>
                    <Route index element={<PlaceholderLanding />} />
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
