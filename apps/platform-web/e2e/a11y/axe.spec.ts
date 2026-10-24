// PLATFORM-UX-1 H-1 — axe (WCAG 2.2 AA, handoff §15; directive §7): every
// screen-state of the visual catalog, in the build, at 1440×900. Gate: 0
// serious and 0 critical violations. Moderate / minor findings are written to
// the test's attachments for the report, not gated.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openBuild, settleBuild } from '../support/build';
import { STATES } from '../visual/states';

const ONLY = process.env['PW_STATE'];

/**
 * DESIGN-vs-WCAG CONFLICTS awaiting a Lead/PO ruling (directive §3 pixel parity
 * vs §7 "no serious axe issue"): these rules fail ONLY on the design file's own
 * palette — the faint ink #93A0A8 (table heads, ⌘K placeholder, mono codes), the
 * muted/info pill pairs, the sign-in eyebrow — and its colour-only inline links.
 * Fixing them changes the pixels the parity suite locks. Lead ruling (PLATFORM-UX-1,
 * 2026-10-24): the LOCKED design wins for this program, so these two rules are
 * reported as known design debt without failing; every other rule must pass.
 * PW_A11Y_DESIGN_CONFLICTS=strict makes them fail (use it once the design's
 * contrast amendment lands). See e2e/visual/DIVERGENCES.md "Accessibility conflicts".
 */
const DESIGN_CONFLICT_RULES = new Set(['color-contrast', 'link-in-text-block']);
const ALLOW_CONFLICTS = process.env['PW_A11Y_DESIGN_CONFLICTS'] !== 'strict';

for (const s of STATES) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  test(`axe ${s.name}`, async ({ page }, info) => {
    const mock = typeof s.build.mock === 'function' ? s.build.mock() : (s.build.mock ?? {});
    await openBuild(page, s.build.path, { ...mock, railCollapsed: s.railCollapsed === true });
    if (s.build.act) await s.build.act(page);
    await settleBuild(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    const summary = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    }));
    await info.attach('axe-violations.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    const serious = summary.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const conflicts = serious.filter((v) => DESIGN_CONFLICT_RULES.has(v.id));
    if (conflicts.length > 0) info.annotations.push({ type: 'design-conflict', description: conflicts.map((c) => c.id).join(', ') });
    const blocking = ALLOW_CONFLICTS ? serious.filter((v) => !DESIGN_CONFLICT_RULES.has(v.id)) : serious;
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
}
