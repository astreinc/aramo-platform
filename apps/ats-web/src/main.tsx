import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAppBasePath } from '@aramo/fe-foundation';

import { App } from './App';
import './index.css';
// Confident Blue theme layer (Phase 1) — imported AFTER the fe-foundation
// barrel (pulled in via App) and index.css, so the :root token re-map wins
// on equal specificity. theme.css = tokens; ui.css = new component styles.
import './ui/theme.css';
import './ui/ui.css';
// Settings Rebuild Directive 1 — the enterprise settings surface (shell rail +
// section primitives + honest seams). Imported after ui.css so it composes on
// the same token layer.
import './settings/settings.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

// D-ORG-2 (topology T1) — the ATS app lives at /ats/ on the tenant host. The
// router basename keeps every in-app <Link>/navigate relative to it; the
// foundation base path covers the host-level redirects it performs itself.
const APP_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
configureAppBasePath(APP_BASE);

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={APP_BASE}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
