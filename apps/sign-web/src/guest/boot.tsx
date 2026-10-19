import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { DownloadApp } from './DownloadApp.js';
import './index.css';

// DOC-4 (R-4-8) — guest signing. Standalone (no auth-consumer / ATS imports): the
// signer is authorized by the capability token, not a session. /d/:token is the
// signer's signed copy (completion email); /s/:token is the signing app.
export function bootGuest(container: HTMLElement, mode: 'sign' | 'download'): void {
  createRoot(container).render(<StrictMode>{mode === 'download' ? <DownloadApp /> : <App />}</StrictMode>);
}
