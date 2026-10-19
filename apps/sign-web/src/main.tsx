import { zoneFor } from './zones.js';

// Sign Unified Product S-2 — the one Aramo Sign application (sign.aramo.ai).
// The zone is decided from the URL before ANY other code loads: guest signing
// pages load only the signer bundle (no session, no @aramo/fe-foundation, no
// workspace code); every other path loads the signed-in workspace.
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

const zone = zoneFor(window.location.pathname, window.location.search);
if (zone === 'workspace') {
  void import('./workspace/boot.js').then((m) => m.bootWorkspace(container));
} else {
  void import('./guest/boot.js').then((m) => m.bootGuest(container, zone === 'guest-download' ? 'download' : 'sign'));
}
