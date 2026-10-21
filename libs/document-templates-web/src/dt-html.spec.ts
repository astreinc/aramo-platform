import { describe, expect, it } from 'vitest';

import { HTML_CODEC } from './dt-block-editor';
import {
  blocksToHtml,
  canonicalInner,
  convertKind,
  htmlToBlocks,
  sanitizeDocHtml,
  sanitizePastedInline,
  scanHtml,
  toggleMark,
} from './dt-html';
import { bindingMapFrom } from './dt-ui';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 — the client-side rtr-html-v1 model: allowlist
// sanitiser, block model, kind conversions, mark toggling and the HTML codec round-trip.

const MAP = bindingMapFrom([
  { key: 'talent.full_name', label: 'Talent full name' },
  { key: 'client.name', label: 'Client name' },
]);

describe('sanitizeDocHtml (allowlist)', () => {
  it('strips script/style/unknown tags and every attribute except data-field', () => {
    const out = sanitizeDocHtml(
      '<p onclick="x()" style="color:red">Hi <script>alert(1)</script><style>p{}</style><strong class="a">B</strong> <em>I</em> '
        + '<a href="https://x">link</a><span data-field="talent.full_name" class="z">junk</span></p><img src="x" onerror="alert(1)">'
        + '<iframe src="x"></iframe>',
    );
    expect(out).toBe('<p>Hi <b>B</b> <i>I</i> link<span data-field="talent.full_name"></span></p>');
    expect(out).not.toMatch(/script|style|onclick|onerror|img|iframe|href|class/);
  });

  it('keeps one tenant-logo div only as the FIRST child', () => {
    expect(sanitizeDocHtml('<div data-asset="tenant.logo">x</div><p>a</p>')).toBe('<div data-asset="tenant.logo"></div><p>a</p>');
    expect(sanitizeDocHtml('<p>a</p><div data-asset="tenant.logo"></div>')).toBe('<p>a</p>');
    expect(sanitizeDocHtml('<div data-asset="tenant.logo"></div><div data-asset="tenant.logo"></div><p>a</p>')).toBe('<div data-asset="tenant.logo"></div><p>a</p>');
  });

  it('normalises blocks: h1/h3 → h2, stray text → p, loose li → ul, ul children → li', () => {
    expect(sanitizeDocHtml('<h1>T</h1>loose<li>x</li><ol>y<li>z</li></ol>')).toBe('<h2>T</h2><p>loose</p><ul><li>x</li></ul><ol><li>y</li><li>z</li></ol>');
  });

  it('data-sample spans survive ONLY in sample mode', () => {
    const html = '<p>Hi <span data-sample="talent.full_name" style="x">Ravi</span></p>';
    expect(sanitizeDocHtml(html)).toBe('<p>Hi Ravi</p>');
    expect(sanitizeDocHtml(html, { allowSample: true })).toBe('<p>Hi <span data-sample="talent.full_name">Ravi</span></p>');
  });
});

describe('paste + block model', () => {
  it('pasted html becomes an inline allowlisted fragment (blocks → <br>)', () => {
    expect(sanitizePastedInline('<div><p style="x">One <b onclick="y">two</b></p><p>Three</p><script>bad()</script></div>')).toBe('One <b>two</b><br>Three');
  });

  it('htmlToBlocks / blocksToHtml round-trip the stored document', () => {
    const html = '<div data-asset="tenant.logo"></div><p>Hi <b>x</b> <span data-field="talent.full_name"></span></p><h2>S</h2><ol><li>a</li></ol>';
    const doc = htmlToBlocks(html);
    expect(doc.logo).toBe(true);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['p', 'h2', 'ol']);
    expect(blocksToHtml(doc.logo, doc.blocks)).toBe(html);
  });

  it('convertKind: paragraph lines ↔ list items', () => {
    expect(convertKind('a<br>b', 'p', 'ul')).toBe('<li>a</li><li>b</li>');
    expect(convertKind('<li>a</li><li>b</li>', 'ol', 'p')).toBe('a<br>b');
    expect(convertKind('<li>a</li>', 'ul', 'ol')).toBe('<li>a</li>');
    expect(convertKind('x', 'p', 'h2')).toBe('x');
  });

  it('canonicalInner merges adjacent marks and drops empty ones', () => {
    expect(canonicalInner('p', '<b>a</b><b>b</b><i></i>')).toBe('<b>ab</b>');
  });

  it('scanHtml finds used + unknown keys and typed [names]', () => {
    const r = scanHtml('<span data-field="client.name"></span> <span data-field="agreed_pay_rate.amount"></span> [Talent full name] [Nope]', MAP.tokenByLabel, (k) => MAP.labelByToken[k] != null);
    expect(r.used).toEqual(['client.name', 'talent.full_name']);
    expect(r.bad).toEqual(['agreed_pay_rate.amount', 'Nope']);
  });
});

describe('HTML_CODEC', () => {
  it('renders chips as atomic removable nodes and serialises back to the canonical value', () => {
    const el = document.createElement('div');
    const value = 'Hi <b>bold <span data-field="client.name"></span></b><br><u>u</u>';
    HTML_CODEC.render(el, value, MAP, 'p');
    const chip = el.querySelector('[data-field="client.name"]');
    expect(chip).toHaveAttribute('contenteditable', 'false');
    expect(chip?.textContent).toContain('Client name');
    expect(el.querySelector('[aria-label="Remove Client name"]')).not.toBeNull();
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe(value);
  });

  it('lists render inside ul/ol and serialise to li items', () => {
    const el = document.createElement('div');
    HTML_CODEC.render(el, '<li>a</li><li><i>b</i></li>', MAP, 'ol');
    expect(el.querySelector('ol')?.children).toHaveLength(2);
    expect(HTML_CODEC.serialize(el, MAP, 'ol')).toBe('<li>a</li><li><i>b</i></li>');
  });

  it('an unknown key renders red and still serialises to its data-field (server rejects it)', () => {
    const el = document.createElement('div');
    HTML_CODEC.render(el, '<span data-field="agreed_pay_rate.amount"></span>', MAP, 'p');
    expect(el.querySelector('[data-bad-field]')?.textContent).toContain('agreed_pay_rate.amount · unknown field');
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe('<span data-field="agreed_pay_rate.amount"></span>');
  });

  it('browser markup (strong/em/styled spans/div) normalises to b/i/u only', () => {
    const el = document.createElement('div');
    el.innerHTML = '<strong>a</strong><em>b</em><span style="font-weight:bold">c</span><div>d</div>';
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe('<b>a</b><i>b</i>cd');
  });
});

describe('toggleMark (Range-based)', () => {
  function setup(value: string) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    HTML_CODEC.render(el, value, MAP, 'p');
    return el;
  }
  it('wraps the selection in b, and unwraps it again', () => {
    const el = setup('Hello world');
    const t = el.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 6);
    r.setEnd(t, 11);
    expect(toggleMark(el, r, 'b')).toBe(true);
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe('Hello <b>world</b>');
    const b = el.querySelector('b') as HTMLElement;
    const r2 = document.createRange();
    r2.selectNodeContents(b);
    expect(toggleMark(el, r2, 'b')).toBe(true);
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe('Hello world');
    el.remove();
  });

  it('never splits a chip — a selection ending inside a chip expands to include it', () => {
    const el = setup('Hi <span data-field="client.name"></span>');
    const t = el.firstChild as Text;
    const label = el.querySelector('[data-field] span') as HTMLElement;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(label.firstChild as Text, 2);
    toggleMark(el, r, 'i');
    expect(HTML_CODEC.serialize(el, MAP, 'p')).toBe('<i>Hi <span data-field="client.name"></span></i>');
    el.remove();
  });

  it('a collapsed selection is a no-op', () => {
    const el = setup('abc');
    const r = document.createRange();
    r.setStart(el.firstChild as Text, 1);
    expect(toggleMark(el, r, 'u')).toBe(false);
    el.remove();
  });
});
