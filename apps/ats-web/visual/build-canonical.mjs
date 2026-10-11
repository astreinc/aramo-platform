// M365-SCHED-1 visual-regression harness — CANONICAL fragment renderer.
//
// Reads the authoritative design-compiler source (Requisitions CRM.dc.html) and
// resolves ONLY the template directives ({{ expr }}, <sc-for>, <sc-if>) with
// deterministic fixtures, preserving the authored inline CSS/DOM verbatim. Emits one
// standalone HTML per surface: schedule dialog, M365 card, Upcoming block, cancel
// confirm. Permitted transformations (only these): resolve directives + insert data;
// strip prototype-only directive attributes (on*/style-hover/style-focus/
// hint-placeholder-*/disabled="{{…}}"); mark the matching <option> selected; load the
// same Google-Fonts Hanken Grotesk the app uses.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = '/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/aramo-Prototype/platform/Requisitions CRM.dc.html';
const OUTDIR = new URL('./canonical/', import.meta.url);
mkdirSync(OUTDIR, { recursive: true });
const ALL = readFileSync(SRC, 'utf8').split('\n');
const TALENT = 'Divya Vasudevan';

function expandScFor(src, listName, as, items) {
  const re = new RegExp(`<sc-for list="\\{\\{ ${listName} \\}\\}"[^>]*>([\\s\\S]*?)</sc-for>`);
  const m = src.match(re);
  if (!m) return src;
  const out = items.map((it) => {
    let frag = m[1];
    for (const [k, v] of Object.entries(it)) frag = frag.replaceAll(`{{ ${as}.${k} }}`, String(v));
    return frag.replace(/disabled="(true|false)"/g, (_, b) => (b === 'true' ? 'disabled' : ''));
  }).join('\n');
  return src.replace(re, out);
}
function keepScIf(src, valName) {
  return src.replace(new RegExp(`<sc-if value="\\{\\{ ${valName} \\}\\}"[^>]*>([\\s\\S]*?)</sc-if>`, 'g'), '$1');
}
function dropScIf(src, valName) {
  return src.replace(new RegExp(`<sc-if value="\\{\\{ ${valName} \\}\\}"[^>]*>([\\s\\S]*?)</sc-if>`, 'g'), '');
}
function stripDirectives(src) {
  return src
    .replace(/\son[A-Za-z]+="\{\{[^}]*\}\}"/g, '')
    .replace(/\sstyle-hover="[^"]*"/g, '')
    .replace(/\sstyle-focus="[^"]*"/g, '')
    .replace(/\shint-placeholder-[a-z]+="[^"]*"/g, '')
    .replace(/\sdisabled="\{\{[^}]*\}\}"/g, '');
}
function doc(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;font-family:'Hanken Grotesk',sans-serif}body{background:#EEF1F4;min-height:100vh}label{display:block}input,select,button{font-family:'Hanken Grotesk',sans-serif}.wrap{max-width:520px;margin:40px auto;padding:16px}</style>
<title>Canonical — ${title}</title></head><body>${body}</body></html>`;
}
function write(name, html) { writeFileSync(new URL(`./${name}`, OUTDIR), html); console.log(`wrote canonical/${name} (${html.length}b)`); }

// ── 1) Schedule dialog (mtOpen 435..477) ──
{
  let b = ALL.slice(434, 477).join('\n');
  const scalars = {
    'pc.n': TALENT, 'pc.reqCode': 'REQ-1000', 'pc.role': 'Business Analyst - Multi-Family',
    mtTitle: 'Schedule meeting',
    mtKindNote: 'A recruiter-owned call. Logged to activity; it does not change the pipeline stage on its own.',
    mtDate: '2026-10-14', mtDateBd: '#D5DBE1', mtTime: '10:30', mtDur: '30',
    mtSubject: `Recruiter screen · ${TALENT} · Business Analyst - Multi-Family`,
    mtFooterNote: 'Idempotent — confirming twice never creates two events.',
    mtBtnBg: '#022AC0', mtBtn: 'Schedule & send invitation',
  };
  const kinds = [
    { label: 'Recruiter screen', w: '700', bg: '#fff', col: '#011F8D', sh: '0 1px 2px rgba(15,25,40,.12)', cur: 'pointer', op: '1', off: false, tip: '' },
    { label: 'Qualification call', w: '500', bg: 'transparent', col: '#5C6770', sh: 'none', cur: 'pointer', op: '1', off: false, tip: '' },
    { label: 'Client interview', w: '500', bg: 'transparent', col: '#93A0A8', sh: 'none', cur: 'not-allowed', op: '.6', off: true, tip: '' },
    { label: 'Follow-up', w: '500', bg: 'transparent', col: '#5C6770', sh: 'none', cur: 'pointer', op: '1', off: false, tip: '' },
  ];
  const people = [
    { top: 'none', bg: '#022AC0', i: 'PP', n: 'Purush Pichaimuthu', email: 'purush@astreconsulting.com', role: 'Organizer · you' },
    { top: '1px solid #EDF0F3', bg: '#6B7A52', i: 'DV', n: TALENT, email: 'vasudevandivya@gmail.com', role: 'Talent' },
  ];
  b = b.replace(/^<sc-if value="\{\{ mtOpen \}\}"[^>]*>\n/, '').replace(/\n<\/sc-if>\s*$/, '');
  b = expandScFor(b, 'mtKinds', 'k', kinds);
  b = expandScFor(b, 'mtPeople', 'p', people);
  b = dropScIf(b, 'mtErr'); b = dropScIf(b, 'mtIsClient');
  for (const [k, v] of Object.entries(scalars)) b = b.replaceAll(`{{ ${k} }}`, v);
  b = stripDirectives(b).replace('<option value="30">', '<option value="30" selected>');
  write('schedule-dialog.html', doc('Schedule meeting', b));
}

// ── 2) M365 card (257..263) ──
{
  let b = ALL.slice(256, 263).join('\n');
  b = stripDirectives(b);
  const body = `<div class="wrap"><div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#93A0A8;margin-bottom:9px">Microsoft 365</div>${b}</div>`;
  write('card.html', doc('Microsoft 365 card', body));
}

// ── 3) Upcoming block (mtHas 264..283) ──
{
  let b = ALL.slice(263, 284).join('\n');
  const rows = [{
    top: 'none', day: 'Oct 14', time: '10:30 AM', title: 'Recruiter screen · Teams',
    sub: '30 min · organized by you · on your Outlook calendar', prov: 'Outlook · Teams',
    st: 'Invited', stBg: '#E6F2EA', stCol: '#1F7A4D', joinLabel: 'Join',
  }];
  b = keepScIf(b, 'mtHas');
  b = expandScFor(b, 'mtRows', 'm', rows);
  b = b.replaceAll('{{ pc.n }}', TALENT);
  b = stripDirectives(b);
  write('upcoming.html', doc('Upcoming', `<div class="wrap">${b}</div>`));
}

// ── 4) Cancel confirm (mtCancelOpen 478..487) ──
{
  let b = ALL.slice(477, 487).join('\n');
  b = b.replace(/^<sc-if value="\{\{ mtCancelOpen \}\}"[^>]*>\n/, '').replace(/\n<\/sc-if>\s*$/, '');
  b = b.replaceAll('{{ mtCancelDesc }}', `Recruiter screen with ${TALENT} on Oct 14 at 10:30 AM.`);
  b = stripDirectives(b);
  write('cancel.html', doc('Cancel this meeting?', b));
}
