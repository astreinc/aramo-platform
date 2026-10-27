import { describe, expect, it } from 'vitest';

import {
  STUDIO_LETTERHEAD_HTML,
  STUDIO_LETTERHEAD_KIND,
  appendStudioVariable,
  convertStudioValue,
  createStudioCodec,
  isCanonicalStudioHtml,
  removeStudioVariable,
  renderStudioBlockDom,
  serializeStudioBlockDom,
  studioBlocksFromHtml,
  studioBlocksToHtml,
  studioContentBlocks,
  studioDocFromHtml,
  studioDocHasLetterhead,
  studioDocToHtml,
  studioLetterheadState,
  studioPasteNodes,
  studioPlainText,
  studioPreviewParts,
  studioValueFromText,
  studioVariableKeys,
  type StudioChipResolver,
  type StudioDocBlock,
} from './studio-codec';

// PLATFORM-UX-1 F-9 (directive R-11) — the Studio codec round-trips exactly through the
// rtr-html-v1 contract: design blocks → stored html ({{key}} as <span data-field>) → blocks.

const resolve: StudioChipResolver = (key) =>
  key === 'talent.first_name'
    ? { state: 'known', title: 'First name · e.g. Amina' }
    : key === 'offer.hours_per_week'
      ? { state: 'inactive', title: 'Hours per week · e.g. 40 · inactive' }
      : { state: 'unknown', title: 'Unknown variable — not in Template variables' };

let n = 0;
const newId = (): string => `b${++n}`;

// The design's offer letter, as {{key}} text per block (Template Studio.dc.html offerDraft).
const DESIGN: ReadonlyArray<{ kind: 'p' | 'h2' | 'ul' | 'ol'; value: string }> = [
  { kind: 'h2', value: 'Offer of employment' },
  { kind: 'p', value: 'Dear <span data-field="talent.first_name"></span>,' },
  { kind: 'p', value: 'We are pleased to offer you the position of <b><span data-field="requisition.title"></span></b> at <span data-field="organization.legal_name"></span>.' },
  { kind: 'ul', value: '<li>An annual bonus of <span data-field="offer.bonus_target"></span>.</li><li><i>Equity</i>: <u>plan</u> rules.</li>' },
  { kind: 'ol', value: '<li>Satisfactory references.</li><li>Probation of <span data-field="offer.probation_months"></span> months.</li>' },
  { kind: 'p', value: 'Sincerely,<br><span data-field="organization.signatory"></span>' },
];

describe('studio codec — round trip (blocks → rtr-html-v1 → blocks)', () => {
  it('stores {{key}} as the A1 data-field chip and parses back to identical blocks', () => {
    const html = studioBlocksToHtml(DESIGN);
    expect(html).toContain('<span data-field="talent.first_name"></span>');
    expect(html).not.toContain('{{');
    expect(isCanonicalStudioHtml(html)).toBe(true);
    const back = studioBlocksFromHtml(html, newId);
    expect(back.map((b) => ({ kind: b.kind, value: b.value }))).toEqual(DESIGN);
    expect(studioBlocksToHtml(back)).toBe(html);
  });

  it('round-trips through the editor DOM (render → serialise) with no change', () => {
    for (const b of DESIGN) {
      const el = document.createElement('div');
      renderStudioBlockDom(el, b.value, b.kind, resolve);
      expect(serializeStudioBlockDom(el, b.kind)).toBe(b.value);
    }
  });

  it('{{key}} text becomes a chip with the same stored form', () => {
    expect(studioValueFromText('p', 'Dear {{talent.first_name}}, welcome')).toBe('Dear <span data-field="talent.first_name"></span>, welcome');
    expect(studioValueFromText('ul', 'Item {{a.b}}')).toBe('<li>Item <span data-field="a.b"></span></li>');
  });

  it('sanitises stored html before it becomes blocks (never trusted as markup)', () => {
    const blocks = studioBlocksFromHtml('<p onclick="x()">Hi <script>alert(1)</script><strong>B</strong></p><h3>Sub</h3><div data-asset="tenant.logo"></div>', newId);
    expect(blocks.map((b) => [b.kind, b.value])).toEqual([
      ['p', 'Hi <b>B</b>'],
      ['h2', 'Sub'],
    ]);
  });
});

describe('studio codec — chips', () => {
  it('renders atomic {{key}} chips coloured by state', () => {
    const el = document.createElement('div');
    renderStudioBlockDom(el, 'A <span data-field="talent.first_name"></span> B <span data-field="offer.hours_per_week"></span> <span data-field="x.y"></span>', 'p', resolve);
    const chips = Array.from(el.querySelectorAll('[data-field]'));
    expect(chips.map((c) => c.textContent)).toEqual(['{{talent.first_name}}', '{{offer.hours_per_week}}', '{{x.y}}']);
    expect(chips.map((c) => c.getAttribute('data-state'))).toEqual(['known', 'inactive', 'unknown']);
    expect(chips.every((c) => c.getAttribute('contenteditable') === 'false')).toBe(true);
    expect(chips[0]?.getAttribute('title')).toBe('First name · e.g. Amina');
  });

  it('keeps brackets as ordinary text (no [Label] chip parsing in the Studio)', () => {
    const el = document.createElement('div');
    renderStudioBlockDom(el, 'Fee [see annex]', 'p', resolve);
    expect(el.querySelector('[data-field]')).toBeNull();
    expect(serializeStudioBlockDom(el, 'p')).toBe('Fee [see annex]');
  });

  it('the codec reuses HTML_CODEC for storage and swaps only the chip renderer', () => {
    const codec = createStudioCodec(resolve);
    expect(codec.id).toBe('html-v1');
    const el = document.createElement('div');
    codec.render(el, 'Hi <span data-field="talent.first_name"></span>', { labelByToken: {}, tokenByLabel: {} }, 'p');
    expect(el.querySelector('.pws-chip--known')).not.toBeNull();
    expect(codec.serialize(el, { labelByToken: {}, tokenByLabel: {} }, 'p')).toBe('Hi <span data-field="talent.first_name"></span>');
  });
});

describe('studio codec — helpers', () => {
  it('plain text shows chips as {{key}} (outline, checks, diff)', () => {
    expect(studioPlainText('Dear <span data-field="talent.first_name"></span>,<br><b>x</b>')).toBe('Dear {{talent.first_name}} , x');
    expect(studioPlainText('<li>One</li><li>Two</li>')).toBe('One Two');
  });

  it('lists variable keys with repeats', () => {
    expect(studioVariableKeys('<span data-field="a.b"></span> and <span data-field="a.b"></span> <span data-field="c.d"></span>')).toEqual(['a.b', 'a.b', 'c.d']);
  });

  it('removes every chip for one key and appends a chip', () => {
    expect(removeStudioVariable('p', 'A <span data-field="a.b"></span> B <span data-field="c.d"></span>', 'a.b')).toBe('A  B <span data-field="c.d"></span>');
    expect(appendStudioVariable('p', 'Hello', 'a.b')).toBe('Hello <span data-field="a.b"></span>');
    expect(appendStudioVariable('ul', '<li>One</li>', 'a.b')).toBe('<li>One <span data-field="a.b"></span></li>');
  });

  it('converts kinds like the RTR editor (paragraph ⇄ list)', () => {
    expect(convertStudioValue('One<br>Two', 'p', 'ul')).toBe('<li>One</li><li>Two</li>');
    expect(convertStudioValue('<li>One</li><li>Two</li>', 'ol', 'p')).toBe('One<br>Two');
    expect(convertStudioValue('Title', 'p', 'h2')).toBe('Title');
  });

  it('pastes plain text only, turning {{key}} into chips and newlines into line breaks', () => {
    const data = { getData: (t: string) => (t === 'text/plain' ? 'Hi {{talent.first_name}}\nBye' : '<b>rich</b>') } as unknown as DataTransfer;
    const nodes = studioPasteNodes(data, resolve);
    const el = document.createElement('div');
    nodes.forEach((x) => el.appendChild(x));
    expect(serializeStudioBlockDom(el, 'p')).toBe('Hi <span data-field="talent.first_name"></span><br>Bye');
  });

  it('splits sample-preview html into sanitised top-level parts', () => {
    const parts = studioPreviewParts('<h2>T</h2><p>Dear <span data-sample="talent.first_name">Amina</span></p><script>x</script><ul><li>a</li></ul>');
    expect(parts.map((p) => p.kind)).toEqual(['h2', 'p', 'ul']);
    expect(parts[1]?.html).toBe('<p>Dear <span data-sample="talent.first_name">Amina</span></p>');
    expect(parts[1]?.text).toBe('Dear Amina');
  });
});

// TEMPLATE-STUDIO-1 B-1 (§3.5, §6; DOC-TEMPLATE-ADMIN-RTR-1 A1) — a tenant draft keeps its
// letterhead logo through Studio decode → encode. This exact string is also what the gated
// HTTP spec (apps/api template-studio-1-b12-http.integration.spec.ts) PATCHes, previews and
// activates on a logo-bearing tenant draft.
const TENANT_LOGO_HTML =
  '<div data-asset="tenant.logo"></div><h2>Right to represent</h2><p>We represent <span data-field="talent.full_name"></span> for <span data-field="requisition.title"></span>.</p>';

describe('studio codec — letterhead logo (TEMPLATE-STUDIO-1 B-1)', () => {
  it('decodes the A1 logo node as ONE non-editable letterhead block, first', () => {
    const doc = studioDocFromHtml(TENANT_LOGO_HTML, newId);
    expect(doc.map((b) => b.kind)).toEqual([STUDIO_LETTERHEAD_KIND, 'h2', 'p']);
    expect(doc[0]?.value).toBe('');
    expect(studioDocHasLetterhead(doc)).toBe(true);
    expect(studioContentBlocks(doc).map((b) => b.kind)).toEqual(['h2', 'p']);
  });

  it('round-trips byte-for-byte: decode → encode returns the stored html (logo first, exactly once)', () => {
    const doc = studioDocFromHtml(TENANT_LOGO_HTML, newId);
    const html = studioDocToHtml(doc);
    expect(html).toBe(TENANT_LOGO_HTML);
    expect(html.startsWith(STUDIO_LETTERHEAD_HTML)).toBe(true);
    expect(isCanonicalStudioHtml(html)).toBe(true);
    // An edit to a content block keeps the letterhead.
    const edited = doc.map((b) => (b.kind === 'h2' ? { ...b, value: 'Right to represent (2026)' } : b));
    expect(studioDocToHtml(edited)).toBe(TENANT_LOGO_HTML.replace('Right to represent<', 'Right to represent (2026)<'));
  });

  it('cannot place the logo anywhere but first, or twice (A1): encode normalises', () => {
    const doc = studioDocFromHtml(TENANT_LOGO_HTML, newId);
    const [logo, ...rest] = doc as [StudioDocBlock, ...StudioDocBlock[]];
    expect(studioDocToHtml([...rest, logo])).toBe(TENANT_LOGO_HTML);
    expect(studioDocToHtml([logo, ...rest, logo])).toBe(TENANT_LOGO_HTML);
    // A logo node that is not the first child is not A1 content: sanitised away on decode.
    expect(studioDocHasLetterhead(studioDocFromHtml('<p>x</p><div data-asset="tenant.logo"></div>', newId))).toBe(false);
  });

  it('platform content (no logo) is unchanged: same blocks and same html as the content-only codec', () => {
    const html = studioBlocksToHtml(DESIGN);
    const doc = studioDocFromHtml(html, newId);
    expect(doc.map((b) => ({ kind: b.kind, value: b.value }))).toEqual(DESIGN);
    expect(studioDocHasLetterhead(doc)).toBe(false);
    expect(studioDocToHtml(doc)).toBe(html);
    expect(studioDocToHtml(doc)).toBe(studioBlocksToHtml(studioBlocksFromHtml(html, newId)));
  });

  it('the content-only codec keeps its existing behaviour (letterhead left out)', () => {
    const blocks = studioBlocksFromHtml(TENANT_LOGO_HTML, newId);
    expect(blocks.map((b) => b.kind)).toEqual(['h2', 'p']);
    expect(studioBlocksToHtml(blocks)).toBe(TENANT_LOGO_HTML.slice(STUDIO_LETTERHEAD_HTML.length));
  });

  it('letterhead state mirrors the server logo_asset_mismatch rule', () => {
    const withLogo = studioDocFromHtml(TENANT_LOGO_HTML, newId);
    const without = studioContentBlocks(withLogo);
    const ref = { asset_id: 'asset-1' };
    expect(studioLetterheadState(withLogo, ref)).toBe('ok');
    expect(studioLetterheadState(without, null)).toBe('ok');
    expect(studioLetterheadState(without, ref)).toBe('node_missing');
    expect(studioLetterheadState(withLogo, null)).toBe('asset_missing');
    expect(studioLetterheadState(withLogo, undefined)).toBe('asset_missing');
  });
});
