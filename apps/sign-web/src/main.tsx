import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './index.css';

// DOC-4 (R-4-8) — sign.aramo.ai SPA bootstrap. Standalone (no auth-consumer /
// ATS imports): the signer is authorized by the capability token, not a session.
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
