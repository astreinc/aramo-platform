// M365-SCHED-1 visual-regression harness — CANONICAL fragment renderer.
//
// Reads the authoritative design-compiler source (Requisitions CRM.dc.html), extracts
// the Schedule-meeting dialog block, and resolves ONLY the template directives
// ({{ expr }} interpolation, <sc-for>, <sc-if>) with deterministic fixtures. The
// authored inline CSS/DOM is preserved verbatim — this renderer never redesigns or
// approximates the source (Architect ruling: permitted transformations are limited to
// resolving directives + inserting data).
//
// Documented transformations (and only these):
//   1. Strip the <sc-if value="{{ mtOpen }}"> wrapper (dialog is always shown here).
//   2. Expand <sc-for list="{{ mtKinds }}"> → 4 purpose buttons; <sc-for mtPeople> → 2 rows.
//   3. Drop <sc-if mtErr> (no error) and <sc-if mtIsClient> (not a client interview).
//   4. Resolve scalar {{ }} to fixtures (names, labels, note, CTA).
//   5. Remove prototype-only directive attributes: onClick / style-hover / style-focus /
//      hint-placeholder-* / disabled="{{ }}" → a real `disabled` attr when the fixture says so.
//   6. <input value="{{ }}"> → value="..."; <select value="{{ mtDur }}"> → `selected` on the match.
//   7. Wrap in a minimal HTML doc loading the same Google-Fonts Hanken Grotesk the app uses,
//      on a neutral page backdrop, with a CSS reset box-sizing:border-box (as the app has).

import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/aramo-Prototype/platform/Requisitions CRM.dc.html';
const OUT = new URL('./canonical/schedule-dialog.html', import.meta.url);

const lines = readFileSync(SRC, 'utf8').split('\n');
// mtOpen dialog block: line 435 (<sc-if mtOpen>) .. 477 (</sc-if>), 1-indexed.
let block = lines.slice(434, 477).join('\n');

const TALENT = 'Divya Vasudevan';
const scalars = {
  'pc.n': TALENT,
  'pc.reqCode': 'REQ-1000',
  'pc.role': 'Senior Engineer',
  mtTitle: 'Schedule meeting',
  mtKindNote: 'A recruiter-owned call. Logged to activity; it does not change the pipeline stage on its own.',
  mtDate: '2026-10-14',
  mtDateBd: '#D5DBE1',
  mtTime: '10:30',
  mtDur: '30',
  mtSubject: `Recruiter screen · ${TALENT} · Senior Engineer`,
  mtFooterNote: 'Idempotent — confirming twice never creates two events.',
  mtBtnBg: '#022AC0',
  mtBtn: 'Schedule & send invitation',
};

const kinds = [
  { label: 'Recruiter screen', w: '700', bg: '#fff', col: '#011F8D', sh: '0 1px 2px rgba(15,25,40,.12)', cur: 'pointer', op: '1', off: false, tip: '' },
  { label: 'Qualification call', w: '500', bg: 'transparent', col: '#5C6770', sh: 'none', cur: 'pointer', op: '1', off: false, tip: '' },
  { label: 'Client interview', w: '500', bg: 'transparent', col: '#93A0A8', sh: 'none', cur: 'not-allowed', op: '.6', off: true, tip: `Client interviews can be scheduled once ${TALENT} is submitted to the client` },
  { label: 'Follow-up', w: '500', bg: 'transparent', col: '#5C6770', sh: 'none', cur: 'pointer', op: '1', off: false, tip: '' },
];
const people = [
  { top: 'none', bg: '#022AC0', i: 'PP', n: 'Purush Pichaimuthu', email: 'purush@astreconsulting.com', role: 'Organizer · you' },
  { top: '1px solid #EDF0F3', bg: '#6B7A52', i: 'DV', n: TALENT, email: 'divya@example.com', role: 'Talent' },
];

function expandScFor(src, listName, as, items) {
  const re = new RegExp(`<sc-for list="\\{\\{ ${listName} \\}\\}"[^>]*>([\\s\\S]*?)</sc-for>`);
  const m = src.match(re);
  if (!m) return src;
  const inner = m[1];
  const out = items.map((it) => {
    let frag = inner;
    for (const [k, v] of Object.entries(it)) {
      frag = frag.replaceAll(`{{ ${as}.${k} }}`, String(v));
    }
    // resolve disabled="{{ k.off }}" → real disabled attr or removed
    frag = frag.replace(/disabled="(true|false)"/g, (_, b) => (b === 'true' ? 'disabled' : ''));
    return frag;
  }).join('\n');
  return src.replace(re, out);
}

function dropScIf(src, valName) {
  const re = new RegExp(`<sc-if value="\\{\\{ ${valName} \\}\\}"[^>]*>([\\s\\S]*?)</sc-if>`, 'g');
  return src.replace(re, '');
}

// 1. strip the mtOpen wrapper (keep scrim + container children)
block = block.replace(/^<sc-if value="\{\{ mtOpen \}\}"[^>]*>\n/, '').replace(/\n<\/sc-if>\s*$/, '');
// 2. expand loops
block = expandScFor(block, 'mtKinds', 'k', kinds);
block = expandScFor(block, 'mtPeople', 'p', people);
// 3. drop error + client-only blocks
block = dropScIf(block, 'mtErr');
block = dropScIf(block, 'mtIsClient');
// 4. scalars
for (const [k, v] of Object.entries(scalars)) block = block.replaceAll(`{{ ${k} }}`, v);
// 5. strip prototype-only directive attributes
block = block
  .replace(/\son[A-Za-z]+="\{\{[^}]*\}\}"/g, '')
  .replace(/\sstyle-hover="[^"]*"/g, '')
  .replace(/\sstyle-focus="[^"]*"/g, '')
  .replace(/\shint-placeholder-[a-z]+="[^"]*"/g, '')
  .replace(/\sdisabled="\{\{[^}]*\}\}"/g, '');
// 6. duration select: mark the 30-min option selected (static render of value="30")
block = block.replace('<option value="30">', '<option value="30" selected>');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: 'Hanken Grotesk', sans-serif; }
  /* Neutral page backdrop so the fixed dialog composes exactly as authored. */
  body { background: #EEF1F4; min-height: 100vh; }
  label { display: block; }
  input, select, button { font-family: 'Hanken Grotesk', sans-serif; }
</style>
<title>Canonical — Schedule meeting</title></head>
<body>
${block}
</body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT.pathname} (${html.length} bytes)`);
