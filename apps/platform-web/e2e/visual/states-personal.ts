// Sign Personal — review queue, account drawer, action dialog, reports, pilot
// invites with the one-time code (handoff §8; amendment 3, 5).

import type { Page } from '@playwright/test';

import { PILOT_CODE } from '../fixtures/rest';
import { PERSONAL_DRAWER } from './masks-common';
import type { ScreenState } from './state-types';

const openAccount = (name: string) => async (p: Page) => {
  await p.getByRole('button', { name, exact: true }).click();
};
const protoPa = (id: string, call?: string) => ({ hash: 'personal', state: { paOpen: id }, ...(call ? { call } : {}) });
const paCall = (id: string, act: string) => `c.paAction(c.state.pa.find((x) => x.id === '${id}'), '${act}')`;

export const PERSONAL_STATES: readonly ScreenState[] = [
  { name: 'personal-queue', proto: { hash: 'personal' }, build: { path: '/personal-review' } },
  {
    name: 'personal-queue-filtered',
    proto: { hash: 'personal', state: { paF: 'RESTRICTED' } },
    build: { path: '/personal-review', act: (p) => p.getByRole('button', { name: /^Restricted/ }).first().click() },
  },
  {
    name: 'personal-drawer',
    proto: protoPa('pa_01HV2'),
    build: { path: '/personal-review', act: openAccount('Odile Marchand') },
    masks: PERSONAL_DRAWER,
  },
  {
    name: 'personal-drawer-reports',
    proto: protoPa('pa_01HQ3'),
    build: { path: '/personal-review', act: openAccount('J. Whitcombe') },
    masks: PERSONAL_DRAWER,
  },
  {
    name: 'personal-action-dialog',
    blur: true,
    proto: protoPa('pa_01HV2', paCall('pa_01HV2', 'restrict')),
    build: {
      path: '/personal-review',
      act: async (p) => {
        await openAccount('Odile Marchand')(p);
        await p.getByRole('button', { name: 'Restrict…' }).click();
      },
    },
    masks: PERSONAL_DRAWER,
  },
  { name: 'invites', proto: { hash: 'invites' }, build: { path: '/personal-invites' } },
  {
    name: 'invites-one-time-code',
    proto: { hash: 'invites', state: { inv: { email: '', err: null, used: 50, res: { code: PILOT_CODE.code, email: PILOT_CODE.email, exp: '7 Nov 2026, 15:00 UTC · in 14 days' } } } },
    build: {
      path: '/personal-invites',
      act: async (p) => {
        await p.getByLabel('Email').fill(PILOT_CODE.email);
        await p.getByRole('button', { name: 'Create invite code' }).click();
      },
    },
  },
];
