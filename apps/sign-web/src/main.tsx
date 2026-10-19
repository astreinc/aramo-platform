import { zoneFor } from './zones.js';

// Sign Unified Product S-2 — the one Aramo Sign application (sign.aramo.ai).
// The zone is decided from the URL before ANY other code loads: guest signing
// pages load only the signer bundle (no session, no @aramo/fe-foundation, no
// workspace code); every other path loads the signed-in workspace.
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

// Each zone loads through its own function so each dynamic import keeps its own
// preload list (its JS and CSS). With both imports in one if/else the bundler
// merged them into a single preload call carrying only the guest's stylesheet,
// and the workspace rendered unstyled in production.
async function startWorkspace(root: HTMLElement): Promise<void> {
  const m = await import('./workspace/boot.js');
  m.bootWorkspace(root);
}

async function startGuest(root: HTMLElement, mode: 'sign' | 'download'): Promise<void> {
  const m = await import('./guest/boot.js');
  m.bootGuest(root, mode);
}

const zone = zoneFor(window.location.pathname, window.location.search);
if (zone === 'workspace') {
  void startWorkspace(container);
} else {
  void startGuest(container, zone === 'guest-download' ? 'download' : 'sign');
}
