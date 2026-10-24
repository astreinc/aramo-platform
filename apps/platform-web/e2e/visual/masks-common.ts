// PLATFORM-UX-1 H-1 — shared mask regions (each one a sanctioned divergence in
// DIVERGENCES.md). `proto` locates the region in the design file, `build` in the app.

import type { Page } from '@playwright/test';

import type { Mask } from './state-types';

/** DV-01 — the onboarding funnel's slug line: the dashboard DTO has no slug (R-13). */
export const FUNNEL_TABLE: Mask = {
  proto: (p: Page) => p.locator('section').filter({ has: p.getByRole('heading', { name: 'Onboarding funnel' }) }).locator('table'),
  build: (p: Page) => p.locator('section[aria-labelledby="pd-funnel-title"] table'),
  divergence: 'DV-01',
  // The taller design table pushes the activity card down when the panels stack.
  toBottom: true,
};

/** DV-02 — identity fallback (R-6): /platform/me is not called / refused, so the
 * build shows the session sub + tenant id where the design shows a name. */
export const IDENTITY_FALLBACK: readonly Mask[] = [
  { proto: (p) => p.locator('[role="banner"] > span').nth(2), build: (p) => p.getByTestId('envbar-identity'), divergence: 'DV-02' },
  { proto: (p) => p.locator('nav[aria-label="Platform admin"] > div').last(), build: (p) => p.locator('.rc-rail__foot'), divergence: 'DV-02' },
  { proto: (p) => p.locator('button[aria-haspopup="menu"] > span').first(), build: (p) => p.locator('.pw-account__trigger .pw-account__avatar'), divergence: 'DV-02' },
  { proto: (p) => p.locator('main h1 + p + div > span:nth-child(2), main h1 + p + div > span:nth-child(4)'), build: (p) => p.locator('.pw-denied__email, .pw-denied__org'), divergence: 'DV-02' },
];

/** DV-03 — the read-only persona's role label: no read-only platform role exists
 * (libs/identity role catalog), so its label is the fixture key's sentence case. */
export const AUDITOR_ROLE: readonly Mask[] = [
  { proto: (p) => p.locator('[role="banner"] > span').nth(2), build: (p) => p.getByTestId('envbar-identity'), divergence: 'DV-03' },
  { proto: (p) => p.locator('nav[aria-label="Platform admin"] > div').last(), build: (p) => p.locator('.rc-rail__foot'), divergence: 'DV-03' },
];

/** DV-05 — the domain claim's "Since" date: the domain response has no claim
 * date (R-13), so the build shows the designed empty value. */
export const DOMAIN_SINCE: Mask = {
  proto: (p: Page) => p.getByText('Since', { exact: true }).locator('xpath=following-sibling::*[1]'),
  build: (p: Page) => p.getByTestId('domain-since'),
  divergence: 'DV-05',
};

/** DV-06 — the tenant role catalog: the real role keys (tenant-roles.ts) win over
 * the design's 7 sample roles, so the chip list (and the card below it) is taller. */
export const TENANT_ROLES: Mask = {
  proto: (p: Page) => p.locator('[role="group"]').filter({ has: p.getByRole('button', { name: 'Tenant admin' }) }),
  build: (p: Page) => p.locator('.pt-chips'),
  divergence: 'DV-06',
  toBottom: true,
  // The card's padding + border, so the taller card's corners stay inside.
  padLeft: 22,
  padRight: 22,
};

/** DV-07 — a real reason/claim code shown in mono differs from the design's sample code. */
export const realCode = (protoCode: string, buildCode: string): Mask => ({
  proto: (p: Page) => p.getByText(protoCode, { exact: true }),
  build: (p: Page) => p.getByText(buildCode, { exact: true }),
  divergence: 'DV-07',
  textBox: true,
  padRight: 32,
});

/** DV-08 — billing events: the build adds the raw event code in mono under the
 * human label (builder brief hard rule "human labels, raw code secondary in
 * mono"); the design shows the label only, so each row is taller. */
export const BILLING_EVENT_CODES: Mask = {
  proto: (p: Page) => p.locator('section').filter({ has: p.getByRole('heading', { name: 'Recent billing events' }) }).locator('table'),
  build: (p: Page) => p.locator('section').filter({ has: p.getByRole('heading', { name: 'Recent billing events' }) }).locator('table'),
  divergence: 'DV-08',
  toBottom: true,
};

/** A text that legitimately differs (the divergence id says why). */
export const swap = (divergence: string, protoText: string | RegExp, buildText: string | RegExp): Mask => ({
  proto: (p: Page) => p.getByText(protoText, { exact: typeof protoText === 'string' }),
  build: (p: Page) => p.getByText(buildText, { exact: typeof buildText === 'string' }),
  divergence,
  textBox: true,
  padRight: 32,
});

/** DV-11 — the Personal drawer facts/signals that come from real fields the
 * design's sample data doesn't share: the phone step (phone_verified_at /
 * step_up_* → "Phone step done"), and the signal labels (the real signal keys,
 * personal-review-model.ts SIGNAL_LABEL, win over the design's sample keys). */
const PROTO_SIGNALS = /^(High send volume on first day|A recipient reported a message|Several signups from one network|Envelopes to disposable addresses|New device at signup|Phone not verified|Sender name differs from signatory|Brand terms in envelope subject|Signup through an anonymising network|Same document to many unrelated recipients)$/;

export const PERSONAL_DRAWER: readonly Mask[] = [
  { ...swap('DV-11', /^Verified · Verified$/, /^Verified · Phone step done$/), padRight: 60 },
  { proto: (p: Page) => p.getByText(PROTO_SIGNALS), build: (p: Page) => p.locator('.pw-sp-signal__label'), divergence: 'DV-11', textBox: true, padRight: 120 },
];

/** DV-12 — matching role families: the real ROLE_FAMILIES (matching-policy-api.ts)
 * win over the design's sample families; the label column differs, and the
 * auto table layout re-flows every column with it. */
export const ROLE_FAMILY_COLUMN: Mask = {
  proto: (p: Page) => p.locator('main table').first(),
  build: (p: Page) => p.locator('main table').first(),
  divergence: 'DV-12',
};
export const ROLE_FAMILY_DIFF: Mask = {
  proto: (p: Page) => p.locator('[role="dialog"] table'),
  build: (p: Page) => p.locator('[role="dialog"] table'),
  divergence: 'DV-12',
};

/** DV-14 — the dashboard's first load: no refresh has completed, so the build has
 * no "Refreshed HH:MM UTC" time yet (the design shows its seeded time). */
export const REFRESHED_TIME: Mask = {
  proto: (p: Page) => p.getByText(/^Refreshed/).locator('..'),
  build: (p: Page) => p.locator('.pt-head__actions'),
  divergence: 'DV-14',
};

/** DV-13 — skills (directive R-9): the real enums win. Alias types, version
 * status (Active / Inactive, no status on add), relationship sources and the
 * add-form selects show the real labels. */
export const SKILL_ALIAS_TYPES: readonly Mask[] = [
  {
    proto: (p: Page) => p.getByText(/^(Synonym|Misspelling|Colloquial|Translation)$/),
    build: (p: Page) => p.getByRole('tabpanel').getByText(/^(Common name|Spelling variant|Legacy name|Vendor variant)$/),
    divergence: 'DV-13',
    textBox: true,
    padRight: 140,
  },
  { proto: (p: Page) => p.locator('main select'), build: (p: Page) => p.locator('main select'), divergence: 'DV-13', padLeft: 24 },
];
export const SKILL_VERSION_STATUS: readonly Mask[] = [
  {
    proto: (p: Page) => p.getByText(/^(Current|Supported|Legacy)$/),
    build: (p: Page) => p.getByRole('tabpanel').getByText(/^(Active|Inactive)$/),
    divergence: 'DV-13',
    textBox: true,
    padLeft: 24,
    padRight: 24,
  },
  { proto: (p: Page) => p.locator('main select'), build: (p: Page) => p.locator('main select'), divergence: 'DV-13' },
];
export const SKILL_REL_SOURCES: Mask = {
  proto: (p: Page) => p.getByText(/(Curated|AI proposal|Import|Tenant signal)$/),
  build: (p: Page) => p.getByRole('tabpanel').getByText(/(Admin curated|AI recommended|Imported taxonomy|Vendor documentation)$/),
  divergence: 'DV-13',
  textBox: true,
  padLeft: 130,
  padRight: 160,
};

/** DV-15 — the skill review queue (R-9): First seen dropped, and queue rows are
 * counts-only (no source domain under All), so the columns re-flow. */
export const QUEUE_TABLE: Mask = {
  proto: (p: Page) => p.locator('main table'),
  build: (p: Page) => p.locator('main table'),
  divergence: 'DV-15',
  toBottom: true,
};

/** DV-13 / DV-16 — proposals: the real source enum (AI_RECOMMENDED → "AI
 * recommended") and alias types (R-9); no evidence line (the proposal DTO
 * carries none, R-13); the breadcrumb ends in the proposal (directive §6 F-2). */
export const PROPOSAL_MASKS: readonly Mask[] = [
  { ...swap('DV-13', /^AI · (surface clustering|co-occurrence)/, /^AI recommended/), padRight: 120 },
  { ...swap('DV-13', /^(Colloquial|Synonym|Abbreviation|Misspelling)$/, /^(Common name|Abbreviation|Spelling variant)$/), padRight: 40, padLeft: 40 },
  {
    proto: (p: Page) => p.getByText(/^Evidence:/).locator('..'),
    build: (p: Page) => p.getByRole('button', { name: 'Accept and apply' }).locator('..'),
    divergence: 'DV-16',
    toBottom: true,
  },
  {
    proto: (p: Page) => p.getByRole('navigation', { name: 'Breadcrumb' }),
    build: (p: Page) => p.getByRole('navigation', { name: 'Breadcrumb' }),
    divergence: 'DV-16',
    padRight: 360,
  },
];

/** DV-13 — the skills registry (R-9): the Aliases column is dropped, and the
 * server returns skills by canonical name (skill.repository orderBy), not the
 * design's sample order. */
export const REGISTRY_TABLE: readonly Mask[] = [
  { proto: (p: Page) => p.locator('main table'), build: (p: Page) => p.locator('main table'), divergence: 'DV-13', toBottom: true },
  // Search covers names only: the list response carries no aliases (R-9).
  { proto: (p: Page) => p.getByPlaceholder('Search names and aliases'), build: (p: Page) => p.getByPlaceholder('Search skill names'), divergence: 'DV-13' },
];

/** DV-17 — merge consequence: the real merge is a SOFT merge (skill-registry
 * service: the loser goes inactive and points at the winner; its aliases,
 * versions and relationships are not moved), so the design's "move to the
 * winner" copy would be untrue. */
export const MERGE_COPY: Mask = {
  proto: (p: Page) => p.getByText(/^Aliases, versions and relationships move to the winner/),
  build: (p: Page) => p.getByText(/becomes inactive and resolves to the winner everywhere/),
  divergence: 'DV-17',
  padBottom: 4,
};

/** DV-18 — vocabulary (directive R-18): the design copy uses a term that
 * scripts/verify-vocabulary.sh bans (TIER2_TERMS_REGEX); the build uses the
 * nearest compliant wording, which wraps differently. */
export const ACTIVATE_COPY: Mask = {
  proto: (p: Page) => p.getByText(/^Matching across every tenant uses these thresholds/),
  build: (p: Page) => p.getByText(/^Matching across every tenant uses these thresholds/),
  divergence: 'DV-18',
  padBottom: 4,
  padRight: 8,
};
