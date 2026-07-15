import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';

import { App } from './App';
// Base reset. The design tokens + fonts + structural component CSS all arrive via
// the @aramo/fe-foundation barrel (side-effect imports); theme.css re-maps them to
// the portal accent and is imported AFTER the barrel (pulled in via App) so its
// :root rules win on equal specificity — the same load-order contract as the
// other consoles.
import './index.css';
import './theme.css';

// Portal P1 PR-3 — the single auth-consumer bootstrap. portal-web authenticates
// as the auth-service `portal` consumer, so every fe-foundation auth path
// resolves to /auth/portal/* (session, logout, refresh). The portal login itself
// is passwordless (request-link / consume, handled in LoginPage + the backend),
// not the OAuth login the platform/recruiter consumers use — see App/LoginPage.
// This MUST run before the first session fetch (before <App/> mounts useSession).
configureAuthConsumer('portal');

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
