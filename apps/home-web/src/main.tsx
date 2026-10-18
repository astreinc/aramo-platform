import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAppBasePath, configureAuthConsumer } from '@aramo/fe-foundation';

import { App } from './App';
// Base reset, then the Confident Blue token layer (imported AFTER the
// fe-foundation barrel, pulled in via App, so its :root re-map wins on equal
// specificity — the same load-order contract as ats-web / platform-web), then
// the App Home's own structural styles.
import './index.css';
import './theme.css';
import './home.css';

// D-ORG — the App Home authenticates as the auth-service `org` consumer (the
// SIXTH consumer: product-neutral, mapped to the `core` capability, carrying only
// the organization scope subset). Every fe-foundation auth path resolves to
// /auth/org/* (login, session, logout, refresh). MUST run before the first
// session fetch (before <App/> mounts useSession).
configureAuthConsumer('org');
// D-ORG-2 (topology T1) — this SPA owns the host root: App Home at `/`,
// Organization Administration at `/org/*`. No base path.
configureAppBasePath('');

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
