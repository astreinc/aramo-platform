// Tenants list, Provision (steps 1–3 + an error), tenant detail (5 tabs, the
// lifecycle menu, each lifecycle dialog, view-only) — handoff §6, §7.

import type { Page } from '@playwright/test';

import { AUDITOR_ROLE, DOMAIN_SINCE, TENANT_ROLES, BILLING_EVENT_CODES, realCode, swap } from './masks-common';
import type { ScreenState } from './state-types';

const NORTHWIND = 'tn_01J8Q2NWX4';
const MERIDIAN = 'tn_01J9MRDF7T';
const HALVORSEN = 'tn_01JA7HVC2K';

const PV = { name: 'Juniper Health', kind: 'BUSINESS', email: 'anna.berg@juniperhealth.com', display: 'Anna Berg', slug: '', caps: { core: true, ats: true, portal: true, sourcing: false, sign: false, intelligence: false }, send: true };

async function fillStep1(p: Page, name = PV.name): Promise<void> {
  await p.getByLabel('Tenant name').fill(name);
  await p.getByLabel('Owner email').fill(PV.email);
  await p.getByLabel('Owner display name').fill(PV.display);
}
const cont = (p: Page) => p.getByRole('button', { name: 'Continue' }).click();
const review = (p: Page) => p.getByRole('button', { name: 'Review' }).click();

async function openLifecycle(p: Page, action: RegExp): Promise<void> {
  await p.locator('.pw-lcmenu button[aria-haspopup="menu"]').click();
  await p.getByRole('menuitem', { name: action }).click();
}

const CAPS4 = swap('DV-09', 'core, ats, portal, sign', 'Core, ATS, Portal, Sign');
const CAPS3 = swap('DV-09', 'core, ats, portal', 'Core, ATS, Portal');

const tenant = (id: string, tab = 'overview') => `/tenants/${id}?tab=${tab}`;
const protoTenant = (id: string, tab = 'overview') => ({ hash: 'tenants', state: { route: 'tenant', tenantId: id, tab } });

export const TENANT_STATES: readonly ScreenState[] = [
  // ---- list -----------------------------------------------------------------
  { name: 'tenants-list', proto: { hash: 'tenants' }, build: { path: '/tenants' } },
  { name: 'tenants-list-filtered', proto: { hash: 'tenants', state: { sf: 'ACTIVE' } }, build: { path: '/tenants?status=ACTIVE' } },
  { name: 'tenants-list-empty', proto: { hash: 'tenants', state: { q: 'zzz' } }, build: { path: '/tenants?q=zzz' } },
  // ---- provision --------------------------------------------------------------
  { name: 'provision-step1', proto: { hash: 'provision' }, build: { path: '/tenants/new' } },
  {
    name: 'provision-step1-invalid',
    proto: { hash: 'provision', state: { pvTouched: true } },
    build: { path: '/tenants/new', act: cont },
  },
  {
    name: 'provision-step2',
    proto: { hash: 'provision', state: { pv: PV, pvStep: 2 } },
    build: { path: '/tenants/new', act: async (p) => { await fillStep1(p); await cont(p); } },
  },
  {
    name: 'provision-step3',
    proto: { hash: 'provision', state: { pv: PV, pvStep: 3 } },
    build: { path: '/tenants/new', act: async (p) => { await fillStep1(p); await cont(p); await review(p); } },
  },
  {
    name: 'provision-error',
    proto: {
      hash: 'provision',
      state: { pv: { ...PV, name: 'Northwind Logistics' }, pvStep: 1, pvErr: ['TENANT_ALREADY_EXISTS', 'A tenant with this name or slug already exists. Choose a different name or slug.'] },
    },
    build: {
      path: '/tenants/new',
      mock: { overrides: [{ method: 'POST', path: /^\/platform\/tenants$/, reply: { status: 409, body: { error: { code: 'TENANT_ALREADY_EXISTS', message: 'Tenant already exists' } } } }] },
      act: async (p) => {
        await fillStep1(p, 'Northwind Logistics');
        await cont(p);
        await review(p);
        await p.getByRole('button', { name: 'Provision tenant' }).click();
      },
    },
  },
  // ---- detail: tabs -------------------------------------------------------------
  { name: 'tenant-overview', proto: protoTenant(NORTHWIND), build: { path: tenant(NORTHWIND) }, masks: [swap('DV-09', 'core, ats, portal, sign', 'Core, ATS, Portal, Sign')] },
  { name: 'tenant-overview-provisioned', proto: protoTenant(HALVORSEN), build: { path: tenant(HALVORSEN) }, masks: [swap('DV-09', 'core, ats, portal', 'Core, ATS, Portal')] },
  { name: 'tenant-lifecycle', proto: protoTenant(MERIDIAN, 'lifecycle'), build: { path: tenant(MERIDIAN, 'lifecycle') }, masks: [realCode('owner_first_sign_in', 'owner_first_session')] },
  { name: 'tenant-sign', proto: protoTenant(NORTHWIND, 'sign'), build: { path: tenant(NORTHWIND, 'sign') }, masks: [BILLING_EVENT_CODES] },
  { name: 'tenant-sign-none', proto: protoTenant(HALVORSEN, 'sign'), build: { path: tenant(HALVORSEN, 'sign') } },
  { name: 'tenant-domain', proto: protoTenant(HALVORSEN, 'domain'), build: { path: tenant(HALVORSEN, 'domain') }, masks: [DOMAIN_SINCE] },
  { name: 'tenant-domain-exception', proto: protoTenant('tn_01J6KTP3MZ', 'domain'), build: { path: tenant('tn_01J6KTP3MZ', 'domain') }, masks: [DOMAIN_SINCE] },
  { name: 'tenant-people', proto: protoTenant(NORTHWIND, 'people'), build: { path: tenant(NORTHWIND, 'people') }, masks: [TENANT_ROLES] },
  // ---- detail: lifecycle menu + dialogs -------------------------------------------
  {
    name: 'tenant-lifecycle-menu',
    proto: { ...protoTenant(NORTHWIND), state: { ...protoTenant(NORTHWIND).state, lcMenu: true } },
    build: { path: tenant(NORTHWIND), act: (p) => p.locator('.pw-lcmenu button[aria-haspopup="menu"]').click() },
    masks: [swap('DV-09', 'core, ats, portal, sign', 'Core, ATS, Portal, Sign')],
  },
  {
    name: 'dialog-suspend',
    blur: true,
    proto: { ...protoTenant(NORTHWIND), call: `c.lifecycle(c.T('${NORTHWIND}'), 'suspend')` },
    build: { path: tenant(NORTHWIND), act: (p) => openLifecycle(p, /^Suspend/) },
    masks: [CAPS4],
  },
  {
    name: 'dialog-offboard',
    blur: true,
    proto: { ...protoTenant(NORTHWIND), call: `c.lifecycle(c.T('${NORTHWIND}'), 'offboard')` },
    build: { path: tenant(NORTHWIND), act: (p) => openLifecycle(p, /^Start offboarding/) },
    masks: [CAPS4],
  },
  {
    name: 'dialog-reactivate',
    blur: true,
    proto: { ...protoTenant(MERIDIAN), call: `c.lifecycle(c.T('${MERIDIAN}'), 'reactivate')` },
    build: { path: tenant(MERIDIAN), act: (p) => openLifecycle(p, /^Reactivate/) },
    masks: [CAPS4],
  },
  {
    name: 'dialog-close',
    blur: true,
    proto: { ...protoTenant(HALVORSEN), call: `c.lifecycle(c.T('${HALVORSEN}'), 'close')` },
    build: { path: tenant(HALVORSEN), act: (p) => openLifecycle(p, /^Close tenant/) },
    masks: [CAPS3],
  },
  {
    name: 'dialog-domain-promote',
    blur: true,
    proto: { ...protoTenant(HALVORSEN, 'domain'), call: `c.renderVals().td.dm.promote()` },
    build: { path: tenant(HALVORSEN, 'domain'), act: (p) => p.getByRole('button', { name: /^Promote/ }).first().click() },
  },
  // ---- view-only (read-only auditor) -------------------------------------------------
  {
    name: 'tenant-overview-viewonly',
    proto: { props: { persona: 'auditor' }, ...protoTenant(NORTHWIND) },
    build: { path: tenant(NORTHWIND), mock: { persona: 'auditor' } },
    masks: [...AUDITOR_ROLE, swap('DV-09', 'core, ats, portal, sign', 'Core, ATS, Portal, Sign')],
  },
  {
    name: 'tenants-list-viewonly',
    proto: { props: { persona: 'auditor' }, hash: 'tenants' },
    build: { path: '/tenants', mock: { persona: 'auditor' } },
    masks: AUDITOR_ROLE,
  },
];
