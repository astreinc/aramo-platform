import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configureAppBasePath, configureAuthConsumer } from '@aramo/fe-foundation';

import { App } from './App';
import './styles.css';

// PX-V1 §8 — the Sign sender console authenticates as the auth-service `esign`
// consumer: every fe-foundation auth path resolves to /auth/esign/* (login,
// session, refresh, logout) and API calls carry X-Aramo-Consumer: esign. MUST run
// before the first session fetch. The SPA owns the esign.aramo.ai root.
configureAuthConsumer('esign');
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
