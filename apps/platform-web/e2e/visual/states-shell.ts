// Sign-in, signed out, access denied, the shell (rail, account menu, ⌘K) and
// the dashboard (handoff §3, §5, §11).

import { expect, type Page } from '@playwright/test';

import { dashboard } from '../fixtures/tenants';
import { AUDITOR_ROLE, FUNNEL_TABLE, IDENTITY_FALLBACK, REFRESHED_TIME } from './masks-common';
import type { ScreenState } from './state-types';

const funnelCard = FUNNEL_TABLE;

/** DV-04 — the shared, frozen sign-in screen (R-16, R-17): only the copy is ours. */
const copy = (title: RegExp, sub?: RegExp) => async (p: Page) => {
  await expect(p.getByText(title).first()).toBeVisible();
  if (sub) await expect(p.getByText(sub).first()).toBeVisible();
};

export const SHELL_STATES: readonly ScreenState[] = [
  // ---- auth ---------------------------------------------------------------
  { name: 'signin', frozen: 'DV-04', frozenCheck: copy(/Aramo Platform administration|Sign in/), proto: { hash: 'signin' }, build: { path: '/login', mock: { signedOut: true } } },
  {
    name: 'signin-session-ended',
    frozen: 'DV-04',
    frozenCheck: copy(/Your session ended\./, /Sign in again to continue\./),
    proto: { hash: 'signin', state: { authErr: 'session_expired' } },
    build: { path: '/login?error=VALIDATION_ERROR', mock: { signedOut: true } },
  },
  {
    name: 'signin-provider-error',
    frozen: 'DV-04',
    frozenCheck: copy(/The sign-in provider didn’t respond\./, /Try again, or use the other provider\./),
    proto: { hash: 'signin', state: { authErr: 'provider_error' } },
    build: { path: '/login?error=INTERNAL_ERROR', mock: { signedOut: true } },
  },
  {
    name: 'signin-wrong-account',
    frozen: 'DV-04',
    frozenCheck: copy(/different account/i),
    proto: { hash: 'signin', state: { authErr: 'TENANT_ACCESS_DENIED' } },
    build: { path: '/login?error=TENANT_ACCESS_DENIED', mock: { signedOut: true } },
  },
  { name: 'signed-out', frozen: 'DV-04', frozenCheck: copy(/You’ve signed out securely|You've signed out securely/, /Platform administration session has ended/), proto: { hash: 'signedout' }, build: { path: '/signed-out', mock: { signedOut: true } } },
  // ---- access denied (in-shell, R-5) ---------------------------------------
  {
    name: 'denied-console',
    proto: { props: { persona: 'tenantUser' }, hash: 'dashboard' },
    build: { path: '/', mock: { persona: 'tenantUser' } },
    masks: IDENTITY_FALLBACK,
  },
  {
    name: 'denied-page',
    proto: { props: { persona: 'auditor' }, hash: 'admins' },
    build: { path: '/admins', mock: { persona: 'auditor' } },
    masks: AUDITOR_ROLE,
  },
  // ---- shell ----------------------------------------------------------------
  {
    name: 'shell-rail-collapsed',
    railCollapsed: true,
    proto: { hash: 'dashboard' },
    build: { path: '/' },
    masks: [funnelCard],
  },
  {
    name: 'shell-account-menu',
    proto: { hash: 'dashboard', state: { menu: true } },
    build: { path: '/', act: async (p) => p.getByRole('button', { name: /^Account:/ }).click() },
    masks: [funnelCard],
  },
  {
    name: 'shell-cmdk',
    proto: { hash: 'dashboard', state: { cmdk: true, cq: '' } },
    build: { path: '/', act: async (p) => p.getByRole('button', { name: /^Search tenants/ }).click() },
    masks: [funnelCard],
  },
  // ---- dashboard ------------------------------------------------------------
  { name: 'dashboard-loaded', proto: { hash: 'dashboard' }, build: { path: '/' }, masks: [funnelCard] },
  {
    name: 'dashboard-skeleton',
    proto: { props: { demoState: 'loading' }, hash: 'dashboard' },
    build: { path: '/', mock: { overrides: [{ path: /^\/platform\/dashboard$/, reply: 'hang' }] } },
    masks: [REFRESHED_TIME],
  },
  {
    name: 'dashboard-panel-error',
    proto: { props: { demoState: 'error' }, hash: 'dashboard' },
    build: {
      path: '/',
      mock: { overrides: [{ path: /^\/platform\/dashboard$/, reply: { body: { ...dashboard(), recent_activity: null } } }] },
    },
    masks: [funnelCard],
  },
  {
    name: 'dashboard-empty',
    proto: { props: { demoState: 'empty' }, hash: 'dashboard' },
    build: {
      path: '/',
      mock: { overrides: [{ path: /^\/platform\/dashboard$/, reply: { body: { ...dashboard(), onboarding: [], recent_activity: [] } } }] },
    },
  },
];
