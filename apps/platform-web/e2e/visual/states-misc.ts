// Matching policy (table, edit, activate dialog), Template variables (+ dialog),
// Platform admins (+ TypedConfirm dialog) — handoff §9, §10.3; R-8, R-12.

import type { Page } from '@playwright/test';

import { ACTIVATE_COPY, AUDITOR_ROLE, ROLE_FAMILY_COLUMN, ROLE_FAMILY_DIFF } from './masks-common';
import type { ScreenState } from './state-types';

const ADMIN = { email: 'priya.shah@aramo.ai', name: 'Priya Shah' };
const fillAdmin = async (p: Page): Promise<void> => {
  await p.getByLabel('Staff email').fill(ADMIN.email);
  await p.getByLabel('Display name').fill(ADMIN.name);
};

export const MISC_STATES: readonly ScreenState[] = [
  // ---- matching ---------------------------------------------------------------
  { name: 'matching', proto: { hash: 'matching' }, build: { path: '/matching' }, masks: [ROLE_FAMILY_COLUMN] },
  {
    name: 'matching-edit',
    proto: { hash: 'matching', call: 'c.renderVals().mp.startEdit()' },
    build: { path: '/matching', act: (p) => p.getByRole('button', { name: 'Edit as new version' }).click() },
    masks: [ROLE_FAMILY_COLUMN],
  },
  {
    name: 'matching-activate-dialog',
    blur: true,
    proto: { hash: 'matching', call: 'c.renderVals().mp.history[1].activate()' },
    build: { path: '/matching', act: (p) => p.getByRole('button', { name: 'Activate v2…' }).click() },
    masks: [ROLE_FAMILY_DIFF, ROLE_FAMILY_COLUMN, ACTIVATE_COPY],
  },
  {
    name: 'matching-viewonly',
    proto: { props: { persona: 'auditor' }, hash: 'matching' },
    build: { path: '/matching', mock: { persona: 'auditor' } },
    masks: [ROLE_FAMILY_COLUMN, ...AUDITOR_ROLE],
  },
  // ---- template variables -------------------------------------------------------
  { name: 'variables', proto: { hash: 'variables' }, build: { path: '/template-variables' } },
  {
    name: 'variables-dialog',
    blur: true,
    proto: { hash: 'variables', call: 'c.renderVals().vr.add()' },
    build: { path: '/template-variables', act: (p) => p.getByRole('button', { name: '+ Add variable' }).click() },
  },
  // ---- platform admins -----------------------------------------------------------
  { name: 'admins', proto: { hash: 'admins' }, build: { path: '/admins' } },
  {
    name: 'admins-domain-hint',
    blur: true,
    proto: { hash: 'admins', state: { adm: { email: 'priya@gmail.com', name: '', done: null } } },
    build: { path: '/admins', act: (p) => p.getByLabel('Staff email').fill('priya@gmail.com') },
  },
  {
    name: 'admins-typed-confirm',
    blur: true,
    proto: { hash: 'admins', state: { adm: { ...ADMIN, done: null } }, call: 'c.renderVals().ad.submit()' },
    build: {
      path: '/admins',
      act: async (p) => {
        await fillAdmin(p);
        await p.getByRole('button', { name: 'Review invitation…' }).click();
      },
    },
  },
];
