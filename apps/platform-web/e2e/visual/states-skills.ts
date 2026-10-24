// Skills — registry, detail tabs, merge dialog, review queue, proposals with the
// diff and with the 409 (handoff §9; directive R-9).

import type { Page } from '@playwright/test';

import type { MockOptions } from '../fixtures/mock-api';
import { proposal, proposals } from '../fixtures/rest';
import { AUDITOR_ROLE, MERGE_COPY, PROPOSAL_MASKS, QUEUE_TABLE, REGISTRY_TABLE, SKILL_ALIAS_TYPES, SKILL_REL_SOURCES, SKILL_VERSION_STATUS } from './masks-common';
import type { ScreenState } from './state-types';

const KUBE = 'sk_01J1KUBE';
const protoSkill = (tab: string) => ({ hash: 'skills', state: { route: 'skill', skillId: KUBE, skTab: tab } });
const tab = (name: RegExp) => async (p: Page) => p.getByRole('tab', { name }).click();

/** The 409 on accept: the proposal was accepted by another operator a moment ago. */
function staleAccept(): MockOptions {
  let changed: Record<string, string> = {};
  return {
    overrides: [
      {
        method: 'POST',
        path: /^\/platform\/skill-proposals\/pp_01HA\/accept$/,
        reply: () => {
          changed = { pp_01HA: 'ACCEPTED' };
          return { status: 409, body: { error: { code: 'SKILL_PROPOSAL_NOT_PENDING', message: 'Proposal is not pending' } } };
        },
      },
      { path: /^\/platform\/skill-proposals$/, reply: ({ query }) => ({ body: proposals(query.get('status'), changed) }) },
      { path: /^\/platform\/skill-proposals\/pp_01HA$/, reply: () => ({ body: proposal('pp_01HA', changed) }) },
    ],
  };
}

export const SKILL_STATES: readonly ScreenState[] = [
  { name: 'skills-registry', proto: { hash: 'skills' }, build: { path: '/skills' }, masks: REGISTRY_TABLE },
  { name: 'skills-registry-inactive', proto: { hash: 'skills', state: { inclInactive: true } }, build: { path: '/skills', act: (p) => p.getByLabel(/include inactive/i).check() }, masks: REGISTRY_TABLE },
  { name: 'skill-overview', proto: protoSkill('overview'), build: { path: `/skills/${KUBE}` } },
  { name: 'skill-aliases', proto: protoSkill('aliases'), build: { path: `/skills/${KUBE}`, act: tab(/^Aliases/) }, masks: SKILL_ALIAS_TYPES },
  { name: 'skill-versions', proto: protoSkill('versions'), build: { path: `/skills/${KUBE}`, act: tab(/^Versions/) }, masks: SKILL_VERSION_STATUS },
  { name: 'skill-relationships', proto: protoSkill('rels'), build: { path: `/skills/${KUBE}`, act: tab(/^Relationships/) }, masks: [SKILL_REL_SOURCES] },
  {
    name: 'skill-merge-dialog',
    blur: true,
    proto: { ...protoSkill('overview'), call: 'c.renderVals().sd.merge()' },
    build: { path: `/skills/${KUBE}`, act: (p) => p.getByRole('button', { name: 'Merge into…' }).click() },
    masks: [MERGE_COPY],
  },
  {
    name: 'skill-viewonly',
    proto: { props: { persona: 'auditor' }, ...protoSkill('overview') },
    build: { path: `/skills/${KUBE}`, mock: { persona: 'auditor' } },
    masks: AUDITOR_ROLE,
  },
  { name: 'skills-review-queue', proto: { hash: 'skillQueue' }, build: { path: '/skills/review-queue' }, masks: [QUEUE_TABLE] },
  { name: 'skills-proposals', proto: { hash: 'proposals' }, build: { path: '/skills/proposals' }, masks: PROPOSAL_MASKS },
  {
    name: 'skills-proposal-relationship',
    proto: { hash: 'proposals', state: { propSel: 'pp_01H9' } },
    build: { path: '/skills/proposals/pp_01H9' },
    masks: PROPOSAL_MASKS,
  },
  {
    name: 'skills-proposal-409',
    proto: { hash: 'proposals', state: { propSel: 'pp_01HA' }, call: 'c.renderVals().pp.d.accept()' },
    build: { path: '/skills/proposals/pp_01HA', mock: staleAccept, act: (p) => p.getByRole('button', { name: 'Accept and apply' }).click() },
    masks: PROPOSAL_MASKS,
  },
];
