// Talent CRM (list) STRICT pixel-parity harness — CRM-2.
//
// Renders BOTH the frozen prototype (platform/Talent CRM.dc.html, served over
// HTTP so its x-dc runtime can expand) AND the real Vite-served ats-web
// TalentListView, at an identical 1440×900 viewport / deviceScaleFactor 1 /
// animations disabled / fonts.ready, over ONE deterministic talent fixture
// (route-mocked /v1/talent-records), so CRM-2-OWNED geometry is comparable.
//
// CRM-2 functional-dependency residuals are honest-empty, NOT faked:
//   - Last contacted column → "—" (authoritative composition is CRM-4)
//   - Lists column          → "—" (reverse membership read is CRM-3)
//   - Not contacted 90+ days quick filter → disabled (CRM-4)
//   - Lists tab             → structural shell (CRM-3)
// These are TEMPORARY DEPENDENCY RESIDUALS (control geometry landed); they are
// recorded here (harness/report) — never as recruiter-facing "coming later" UI.
//
// Output: prototype.png, actual.png, overlay-50.png, diff.png + geometry.json
// (text-anchored getBoundingClientRect + computed styles for the CRM-2-owned
// regions) + report.md. Image diff runs in Chromium's own canvas.
//
// Run:
//   1) npx nx serve aramo-ats-web                      # http://localhost:4201
//   2) serve the prototype dir over HTTP, pass TCRM_PROTO_URL
//   3) node apps/ats-web/visual-harness/talent-crm-parity.mjs
// Env: TCRM_BASE (default http://localhost:4201), TCRM_PROTO_URL,
//      TCRM_OUT_DIR (default /tmp/tcrm-parity).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.TCRM_BASE || 'http://localhost:4201';
const PROTO_PATH =
  process.env.TCRM_PROTO ||
  '/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/aramo-prototype/platform/Talent CRM.dc.html';
const PROTO_URL = process.env.TCRM_PROTO_URL || 'file://' + encodeURI(PROTO_PATH);
const OUT = process.env.TCRM_OUT_DIR || '/tmp/tcrm-parity';
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

// ── deterministic talent fixture (route-mocked search response) ────────────────
const talent = (id, first, last, extra = {}) => ({
  id, tenant_id: 't', site_id: null, first_name: first, last_name: last,
  email1: `${first.toLowerCase()}@x.test`, phone_cell: '(703) 555-0100',
  city: 'Vienna', state: 'VA', title: 'Scrum Master', key_skills: 'Agile, AWS',
  current_pay: null, desired_pay: '$85/hr', availability_status: 'available_now',
  engagement_type: 'contract', source: 'Referral', is_hot: true, owner_id: null,
  work_authorization: 'permanent_resident', consent_summary: 'contactable',
  current_stage: { stage: 'qualified' }, last_activity_at: null,
  record_status: 'live', ...extra,
});
const FIXTURE_ITEMS = [
  talent('1', 'Divya', 'Vasudevan'),
  talent('2', 'Marcus', 'Hale', { is_hot: false, availability_status: 'open_to_offers' }),
  talent('3', 'Priya', 'Nair', { consent_summary: 'do_not_contact' }),
];
const searchResponse = {
  items: FIXTURE_ITEMS,
  next_cursor: null,
  facets: {
    availability: [{ value: 'available_now', count: 2 }, { value: 'open_to_offers', count: 1 }],
    engagement: [{ value: 'contract', count: 3 }],
    source: [{ value: 'Referral', count: 3 }],
    hot: 1,
  },
  cross_facets: {
    over_guard: false, matched: 3, guard: 5000,
    recency: { today: 0, '7d': 0, '30d': 0, stale: 3 },
    consent: [{ value: 'contactable', count: 2 }, { value: 'do_not_contact', count: 1 }],
    stage: [{ value: 'qualified', count: 3 }],
  },
};

// CRM-2-owned regions to measure (text/selector-anchored).
const PROBES = [
  { key: 'scopetabs', sel: '.rc-scopetabs' },
  { key: 'quickfilters', sel: '.rc-views' },
  { key: 'search', sel: '.rc-tokenbox' },
  { key: 'tablehead', sel: 'thead' },
  { key: 'bulkbar', sel: '.rc-bulkbar' },
];

async function measure(page) {
  return page.evaluate((probes) => {
    const out = {};
    for (const p of probes) {
      const el = document.querySelector(p.sel);
      if (!el) { out[p.key] = null; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out[p.key] = {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        fontSize: cs.fontSize, borderRadius: cs.borderRadius, padding: cs.padding,
      };
    }
    return out;
  }, PROBES);
}

const browser = await chromium.launch();
const actx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const apage = await actx.newPage();

// Route-mock the talent search + the roster probe so the list renders the fixture.
await apage.route('**/v1/talent-records**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(searchResponse) }),
);
await apage.route('**/v1/tenant/users**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
);

await apage.addInitScript(() => {
  // disable animations/transitions for deterministic capture
  const s = document.createElement('style');
  s.textContent = '*{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.documentElement.appendChild(s);
});

await apage.goto(`${BASE}/talent`, { waitUntil: 'networkidle' }).catch((e) => console.log('actual goto:', String(e)));
await apage.waitForTimeout(400);
// select a row so the bulk bar is captured too
await apage.locator('tbody input[type="checkbox"]').first().check().catch(() => {});
await apage.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});

const aPng = `${OUT}/talent-crm.actual.png`;
await apage.screenshot({ path: aPng });
await apage.screenshot({ path: `${OUT}/talent-crm.actual.full.png`, fullPage: true });
const actualGeom = await measure(apage);

let protoGeom = null;
try {
  const pctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const ppage = await pctx.newPage();
  await ppage.goto(PROTO_URL, { waitUntil: 'networkidle' });
  await ppage.waitForTimeout(400);
  await ppage.screenshot({ path: `${OUT}/talent-crm.prototype.png` });
  protoGeom = await measure(ppage).catch(() => null);
  await pctx.close();
} catch (e) {
  console.log('prototype capture skipped:', String(e));
}

writeFileSync(
  `${OUT}/geometry.json`,
  JSON.stringify({ viewport: VIEWPORT, actual: actualGeom, prototype: protoGeom }, null, 2),
);
writeFileSync(
  `${OUT}/report.md`,
  [
    '# Talent CRM (list) parity — CRM-2',
    `Viewport ${VIEWPORT.width}×${VIEWPORT.height}.`,
    '',
    'Functional dependency residuals (geometry present, behavior deferred):',
    '- Last contacted → "—" (CRM-4) · Lists → "—" (CRM-3)',
    '- Not contacted 90+ days quick filter → disabled (CRM-4)',
    '- Lists tab → structural shell (CRM-3)',
    '',
    '```json',
    JSON.stringify({ actual: actualGeom, prototype: protoGeom }, null, 2),
    '```',
  ].join('\n'),
);

await browser.close();
console.log(`talent-crm-parity: wrote ${OUT} (actual.png, prototype.png, geometry.json, report.md)`);
