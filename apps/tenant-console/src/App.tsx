import { Route, Routes } from 'react-router-dom';

import { RouteGuard } from './auth/RouteGuard';
import { useSession } from './auth/session';
import { ConsentView } from './consent/ConsentView';
import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';
import { Shell } from './shell/Shell';

export function App() {
  const state = useSession();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RouteGuard sessionStateOverride={state}>
            {state.status === 'authenticated' ? (
              <Shell session={state.session}>
                <Routes>
                  <Route
                    index
                    element={<LandingPage session={state.session} />}
                  />
                  <Route
                    path="consent/:talentId"
                    element={<ConsentView />}
                  />
                </Routes>
              </Shell>
            ) : null}
          </RouteGuard>
        }
      />
    </Routes>
  );
}
