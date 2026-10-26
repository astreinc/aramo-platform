// CCP-UI-V12 — axe (WCAG 2.2 AA; PLATFORM-UX-1 §15 + CCP handoff §9) on every v1.2 screen-state of
// the parity catalog (e2e/visual/states-ccp-v12.ts), in the build, at 1440×900. Same gate as
// a11y/axe.spec.ts: 0 serious / 0 critical, with the two Lead-ruled design-palette conflicts
// (color-contrast, link-in-text-block) reported, not gated, unless PW_A11Y_DESIGN_CONFLICTS=strict.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openBuild, settleBuild } from '../support/build';
import { CCP_V12_STATES } from '../visual/states-ccp-v12';

const DESIGN_CONFLICT_RULES = new Set(['color-contrast', 'link-in-text-block']);
const ALLOW_CONFLICTS = process.env['PW_A11Y_DESIGN_CONFLICTS'] !== 'strict';

for (const s of CCP_V12_STATES) {
  test(`axe ${s.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const mock = typeof s.build.mock === 'function' ? s.build.mock() : (s.build.mock ?? {});
    await openBuild(page, s.build.path, mock);
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
