// CCP-B5 — axe (WCAG 2.2 AA; PLATFORM-UX-1 §7 gate: 0 serious and 0 critical) on every B5
// screen-state of the governance screens, in the build, at 1440×900. The design-palette
// conflicts the PLATFORM-UX-1 suite reports without failing (Lead ruling 2026-10-24:
// color-contrast, link-in-text-block) are treated the same way here.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { ccpMock } from '../fixtures/ccp-governance';
import { openBuild, settleBuild } from '../support/build';
import { CCP_B5_STATES } from '../visual/ccp-b5-states';

const DESIGN_CONFLICT_RULES = new Set(['color-contrast', 'link-in-text-block']);
const ALLOW_CONFLICTS = process.env['PW_A11Y_DESIGN_CONFLICTS'] !== 'strict';

for (const s of CCP_B5_STATES) {
  test(`axe ${s.name}`, async ({ page }, info) => {
    await openBuild(page, s.build.path, ccpMock(s.build.mock));
    if (s.build.act) await s.build.act(page);
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
