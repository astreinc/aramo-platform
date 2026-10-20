import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAppBasePath, configureAuthConsumer } from '@aramo/fe-foundation';

import { App } from './App';
import './styles.css';

// Sign Unified Product S-2 — the workspace's web fonts. Loaded only by the
// workspace entry, never on guest-signing pages (no third-party fetch where a
// signer's document is shown).
function loadWorkspaceFonts(): void {
  if (document.getElementById('sg-fonts') !== null) return;
  const link = document.createElement('link');
  link.id = 'sg-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap';
  document.head.appendChild(link);
}

// PX-V1 §8 — the Sign sender console authenticates as the auth-service `sign`
// consumer: every fe-foundation auth path resolves to /auth/sign/* (login,
// session, refresh, logout) and API calls carry X-Aramo-Consumer: sign. MUST run
// before the first session fetch. The workspace owns every path of the Sign host
// except the guest-signing zone (zones.ts).
export function bootWorkspace(container: HTMLElement): void {
  configureAuthConsumer('sign');
  configureAppBasePath('');
  loadWorkspaceFonts();
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
