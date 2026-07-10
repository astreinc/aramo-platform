import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';

import { App } from './App';
// Base reset. The design tokens + fonts + structural component CSS all arrive via
// the @aramo/fe-foundation barrel (side-effect imports); theme.css re-maps them to
// the platform accent and is imported AFTER the barrel (pulled in via App) so its
// :root rules win on equal specificity — the same load-order contract as ats-web.
import './index.css';
import './theme.css';

// Inc-2 PR-2 Workstream C — the single auth-consumer bootstrap. platform-web
// authenticates as the auth-service `platform` consumer, so every fe-foundation
// auth path resolves to /auth/platform/* (login, session, logout, refresh). This
// MUST run before the first session fetch (before <App/> mounts useSession).
configureAuthConsumer('platform');

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
