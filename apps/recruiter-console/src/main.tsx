import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './index.css';
// Confident Blue theme layer (Phase 1) — imported AFTER the fe-foundation
// barrel (pulled in via App) and index.css, so the :root token re-map wins
// on equal specificity. theme.css = tokens; ui.css = new component styles.
import './ui/theme.css';
import './ui/ui.css';

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
