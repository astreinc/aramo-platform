// CCP-B4 — axe (WCAG 2.2 AA; PLATFORM-UX-1 §15 + handoff §9) on every Contracts
// screen-state of the B4 parity catalog, in the build, at 1440×900. Same gate as
// a11y/axe.spec.ts: 0 serious / 0 critical, with the two Lead-ruled design-palette
// conflicts (color-contrast, link-in-text-block) reported, not gated, unless
// PW_A11Y_DESIGN_CONFLICTS=strict.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { contractsMock, type CcpPersona } from '../fixtures/contracts';
import { openBuild, settleBuild } from '../support/build';

const DESIGN_CONFLICT_RULES = new Set(['color-contrast', 'link-in-text-block']);
const ALLOW_CONFLICTS = process.env['PW_A11Y_DESIGN_CONFLICTS'] !== 'strict';

const STATES: { name: string; persona: CcpPersona; list?: 'ready' | 'empty' | 'hang'; act?: (p: Page) => Promise<void> }[] = [
  { name: 'contracts-ops', persona: 'tomas' },
  { name: 'contracts-view-only', persona: 'ines' },
  { name: 'contracts-ended', persona: 'tomas', act: (p) => p.getByRole('button', { name: /CT-2024-019/ }).click() },
  { name: 'contracts-empty', persona: 'tomas', list: 'empty' },
  { name: 'contracts-loading', persona: 'tomas', list: 'hang' },
  { name: 'contracts-amend-dialog', persona: 'tomas', act: (p) => p.getByRole('button', { name: 'Record amendment…' }).click() },
  { name: 'contracts-end-dialog', persona: 'tomas', act: (p) => p.getByRole('button', { name: 'End contract…' }).click() },
  { name: 'contracts-access-denied', persona: 'lena' },
];

for (const s of STATES) {
  test(`axe ccp ${s.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuild(page, '/commercial/contracts', contractsMock(s.persona, s.list ?? 'ready'));
    if (s.act) await s.act(page);
    await settleBuild(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    const summary = result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
    await info.attach('axe-violations.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    const serious = summary.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const conflicts = serious.filter((v) => DESIGN_CONFLICT_RULES.has(v.id));
    if (conflicts.length > 0) info.annotations.push({ type: 'design-conflict', description: conflicts.map((c) => c.id).join(', ') });
    const blocking = ALLOW_CONFLICTS ? serious.filter((v) => !DESIGN_CONFLICT_RULES.has(v.id)) : serious;
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
}
