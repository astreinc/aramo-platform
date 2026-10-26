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
import { CCP_STATES } from './states-ccp';
import { CCP_CATALOG_STATES } from './states-ccp-catalog';
import { CCP_SUPPORT_STATES } from './states-ccp-support';
import { CCP_SUBSCRIPTION_STATES } from './states-ccp-subscriptions';
import { CCP_V12_STATES } from './states-ccp-v12';

export const STATES: readonly ScreenState[] = [
  ...SHELL_STATES,
  ...TENANT_STATES,
  ...PERSONAL_STATES,
  ...SKILL_STATES,
  ...MISC_STATES,
  ...STUDIO_STATES,
  // CCP-B1 — the Commercial screens (Commercial Control Plane v1.0.dc.html).
  ...CCP_STATES,
  // CCP-B2 — the Catalog screen.
  ...CCP_CATALOG_STATES,
  // CCP-B6 — the support-extension workflow (Commercial Control Plane v1.0.dc.html).
  ...CCP_SUPPORT_STATES,
  // CCP-B3 — the Subscriptions workbench and Tenant › Commercial.
  ...CCP_SUBSCRIPTION_STATES,
  // CCP-UI-V12 — the CCP-UI v1.2 screens (Commercial Control Plane v1.2.dc.html).
  ...CCP_V12_STATES,
];
