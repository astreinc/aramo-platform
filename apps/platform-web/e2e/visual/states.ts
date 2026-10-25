// PLATFORM-UX-1 H-1 — the screen-state catalog (directive §3.1). Every entry is
// rendered from the design file (reference) and from the build (actual) at
// 1440×900 and 900×900. Masks reference DIVERGENCES.md.

import type { ScreenState } from './state-types';
import { SHELL_STATES } from './states-shell';
import { TENANT_STATES } from './states-tenants';
import { PERSONAL_STATES } from './states-personal';
import { SKILL_STATES } from './states-skills';
import { MISC_STATES } from './states-misc';
import { STUDIO_STATES } from './states-studio';
import { CCP_SUPPORT_STATES } from './states-ccp-support';

export const STATES: readonly ScreenState[] = [
  ...SHELL_STATES,
  ...TENANT_STATES,
  ...PERSONAL_STATES,
  ...SKILL_STATES,
  ...MISC_STATES,
  ...STUDIO_STATES,
  // CCP-B6 — the support-extension workflow (Commercial Control Plane v1.0.dc.html).
  ...CCP_SUPPORT_STATES,
];
