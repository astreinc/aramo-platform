import sanitizeHtml from 'sanitize-html';
import { type RichBlock, type RichListItem, type RichRun } from '@aramo/documents-rendering';

import { isRtrBindingKey, type RtrContentBlock, type RtrTemplateContentV1 } from './rtr-template-content.js';

// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 (LOCKED) — the `rtr-html-v1` content contract.
//
// field_schema = { render_schema_version: 'rtr-html-v1', title, html, logo? }.
// `html` is restricted to the A1 §2.2 allowlist ONLY:
//   p, h2, b/strong, i/em, u, ul, ol, li, br
//   <span data-field="{closed catalog key}"></span>   (empty; key must be in the catalog)
//   <div data-asset="tenant.logo"></div>             (at most one, only as the first child)
// No other elements, no other attributes, no style/class, no URLs. Server-side
// sanitisation is AUTHORITATIVE (sanitize-html, pinned exact version in package.json):
// every PATCH re-serialises the content against the allowlist. `logo` is SERVER-OWNED
// (set only by the logo-capture route) and is never accepted from the client.

export const RTR_HTML_SCHEMA_V1 = 'rtr-html-v1';
export const RTR_HTML_MAX_BYTES = 64 * 1024;
export const TENANT_LOGO_ASSET = 'tenant.logo';

export interface RtrHtmlLogoRef {
  asset_id: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg';
}

export interface RtrTemplateContentHtmlV1 {
  render_schema_version: typeof RTR_HTML_SCHEMA_V1;
  title: string;
  html: string;
  logo?: RtrHtmlLogoRef | null;
}

export type RtrTemplateContent = RtrTemplateContentV1 | RtrTemplateContentHtmlV1;

export function isHtmlContent(c: RtrTemplateContent): c is RtrTemplateContentHtmlV1 {
  return c.render_schema_version === RTR_HTML_SCHEMA_V1;
}

// ── Sanitiser (authoritative) ────────────────────────────────────────────────────
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'h2', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'span', 'div'],
  allowedAttributes: { span: ['data-field'], div: ['data-asset'] },
  allowedSchemes: [],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // script/style/textarea/etc. are dropped WITH their content (sanitize-html default
  // nonTextTags) — never surfaced as text.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'title', 'head', 'iframe', 'object', 'embed', 'svg', 'math'],
  // Normalise synonyms so the stored form is canonical.
  transformTags: { strong: 'b', em: 'i' },
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
};

// ── Minimal tree over SANITISED output only ────────────────────────────────────────
// sanitize-html's output contains only allowlisted tags with only data-field/data-asset
// attributes and entity-escaped text, so this small tokenizer is total over it.
export type HtmlNode =
  | { type: 'text'; text: string }
  | { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

const VOID_TAGS = new Set(['br']);

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseSanitized(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: Array<{ tag: string; children: HtmlNode[] }> = [{ tag: '#root', children: root }];
  const re = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1] as { tag: string; children: HtmlNode[] };
    if (m[5] !== undefined) {
      top.children.push({ type: 'text', text: decodeEntities(m[5]) });
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2] as string;
    if (closing) {
      // pop to the matching open tag (sanitised output is well-formed).
      for (let i = stack.length - 1; i > 0; i--) {
        if ((stack[i] as { tag: string }).tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      attrs[a[1] as string] = decodeEntities(a[2] ?? '');
    }
    const el: HtmlNode = { type: 'el', tag, attrs, children: [] };
    top.children.push(el);
    if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push({ tag, children: el.children });
  }
  return root;
}

// Canonicalise: data-field spans become EMPTY; spans without data-field are unwrapped;
// divs other than the tenant-logo node are unwrapped; the logo div is emptied.
function canonicalise(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push(n);
      continue;
    }
    if (n.tag === 'span') {
      const key = n.attrs['data-field'];
      if (key !== undefined && key.length > 0) out.push({ type: 'el', tag: 'span', attrs: { 'data-field': key }, children: [] });
      else out.push(...canonicalise(n.children));
      continue;
    }
    if (n.tag === 'div') {
      if (n.attrs['data-asset'] !== undefined) out.push({ type: 'el', tag: 'div', attrs: { 'data-asset': n.attrs['data-asset'] }, children: [] });
      else out.push(...canonicalise(n.children));
      continue;
    }
    out.push({ type: 'el', tag: n.tag, attrs: {}, children: canonicalise(n.children) });
  }
  return out;
}

export function serialize(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return escapeHtml(n.text);
      const attrs = Object.entries(n.attrs)
        .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
        .join('');
      if (VOID_TAGS.has(n.tag)) return `<${n.tag}${attrs}>`;
      return `<${n.tag}${attrs}>${serialize(n.children)}</${n.tag}>`;
    })
    .join('');
}

export interface HtmlValidationIssue {
  reason: 'unknown_field' | 'logo_position' | 'content_too_large' | 'unknown_asset';
  keys?: string[];
}

export function collectFieldKeys(nodes: readonly HtmlNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type !== 'el') continue;
    if (n.tag === 'span' && n.attrs['data-field'] !== undefined) out.push(n.attrs['data-field'] as string);
    collectFieldKeys(n.children, out);
  }
  return out;
}

function countAssets(nodes: readonly HtmlNode[]): { count: number; nonTenantLogo: string[] } {
  let count = 0;
  const nonTenantLogo: string[] = [];
  const walk = (ns: readonly HtmlNode[]): void => {
    for (const n of ns) {
      if (n.type !== 'el') continue;
      if (n.tag === 'div' && n.attrs['data-asset'] !== undefined) {
        count += 1;
        if (n.attrs['data-asset'] !== TENANT_LOGO_ASSET) nonTenantLogo.push(n.attrs['data-asset'] as string);
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return { count, nonTenantLogo };
}

export function hasLogoNode(nodes: readonly HtmlNode[]): boolean {
  const first = nodes.find((n) => !(n.type === 'text' && n.text.trim() === ''));
  return first !== undefined && first.type === 'el' && first.tag === 'div' && first.attrs['data-asset'] === TENANT_LOGO_ASSET;
}

// Sanitise + canonicalise + validate. Returns the canonical html (what is stored and
// returned to the FE) or the first validation issue.
// DOC-TEMPLATE-LIB-1 T-2 — `isKnownKey` lets the capability port validate against the Aramo
// variable catalog (active, resolvable keys); it defaults to the resolver key set, so the
// render-time callers (binding / resolver) keep their existing closed check.
export function sanitizeRtrHtml(
  html: string,
  isKnownKey: (key: string) => boolean = isRtrBindingKey,
): { html: string; nodes: HtmlNode[] } | { issue: HtmlValidationIssue } {
  if (Buffer.byteLength(html, 'utf8') > RTR_HTML_MAX_BYTES) return { issue: { reason: 'content_too_large' } };
  const cleaned = sanitizeHtml(html, SANITIZE_OPTIONS);
  const nodes = canonicalise(parseSanitized(cleaned));
  const unknown = [...new Set(collectFieldKeys(nodes).filter((k) => !isKnownKey(k)))];
  if (unknown.length > 0) return { issue: { reason: 'unknown_field', keys: unknown } };
  const assets = countAssets(nodes);
  if (assets.nonTenantLogo.length > 0) return { issue: { reason: 'unknown_asset', keys: assets.nonTenantLogo } };
  if (assets.count > 1 || (assets.count === 1 && !hasLogoNode(nodes))) return { issue: { reason: 'logo_position' } };
  const out = serialize(nodes);
  if (Buffer.byteLength(out, 'utf8') > RTR_HTML_MAX_BYTES) return { issue: { reason: 'content_too_large' } };
  return { html: out, nodes };
}

// ── v1 → rtr-html-v1 conversion (draft creation, A1 §2.1) ──────────────────────────
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function textToHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += escapeHtml(text.slice(last, m.index)).replace(/\n/g, '<br>');
    out += `<span data-field="${escapeHtml(m[1] as string)}"></span>`;
    last = (m.index ?? 0) + m[0].length;
  }
  out += escapeHtml(text.slice(last)).replace(/\n/g, '<br>');
  return out;
}

export function convertV1ToHtml(content: RtrTemplateContentV1): RtrTemplateContentHtmlV1 {
  const html = content.blocks
    .map((b: RtrContentBlock) => (b.type === 'HEADING' ? `<h2>${textToHtml(b.text)}</h2>` : `<p>${textToHtml(b.text)}</p>`))
    .join('');
  return { render_schema_version: RTR_HTML_SCHEMA_V1, title: content.title, html, logo: null };
}

// ── Sample preview html (A1 / coordinator contract §7) ─────────────────────────────
export function htmlWithSamples(nodes: readonly HtmlNode[], sample: (key: string) => string): string {
  const map = (ns: readonly HtmlNode[]): HtmlNode[] =>
    ns.map((n) => {
      if (n.type === 'el' && n.tag === 'span' && n.attrs['data-field'] !== undefined) {
        const key = n.attrs['data-field'] as string;
        const lines = sample(key).split('\n');
        const children: HtmlNode[] = [];
        lines.forEach((l, i) => {
          if (i > 0) children.push({ type: 'el', tag: 'br', attrs: {}, children: [] });
          if (l.length > 0) children.push({ type: 'text', text: l });
        });
        return { type: 'el', tag: 'span', attrs: { 'data-sample': key }, children };
      }
      return n.type === 'el' ? { ...n, children: map(n.children) } : n;
    });
  return serialize(map(nodes));
}

// ── Rich render model (bound values substituted as plain text, marks kept) ──────────
interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function runsOf(nodes: readonly HtmlNode[], value: (key: string) => string, marks: Marks, out: RichRun[]): RichRun[] {
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push({ text: n.text.replace(/\u00a0/g, ' '), ...marks });
      continue;
    }
    switch (n.tag) {
      case 'br':
        out.push({ text: '\n', ...marks });
        break;
      case 'b':
      case 'strong':
        runsOf(n.children, value, { ...marks, bold: true }, out);
        break;
      case 'i':
      case 'em':
        runsOf(n.children, value, { ...marks, italic: true }, out);
        break;
      case 'u':
        runsOf(n.children, value, { ...marks, underline: true }, out);
        break;
      case 'span': {
        const key = n.attrs['data-field'];
        if (key !== undefined) out.push({ text: value(key), ...marks });
        break;
      }
      default:
        // block-level nested inside inline context (e.g. <p> inside <li>) — flatten.
        runsOf(n.children, value, marks, out);
    }
  }
  return out;
}

const NO_MARKS: Marks = { bold: false, italic: false, underline: false };

function listItems(list: HtmlNode & { type: 'el' }, value: (key: string) => string): RichListItem[] {
  const items: RichListItem[] = [];
  for (const child of list.children) {
    if (child.type !== 'el' || child.tag !== 'li') continue;
    const inline = child.children.filter((c) => !(c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')));
    const nested = child.children.filter((c): c is HtmlNode & { type: 'el' } => c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol'));
    items.push({
      runs: runsOf(inline, value, NO_MARKS, []),
      children: nested.map((l) => ({ kind: 'list' as const, ordered: l.tag === 'ol', items: listItems(l, value) })),
    });
  }
  return items;
}

export function toRichBlocks(nodes: readonly HtmlNode[], value: (key: string) => string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let loose: HtmlNode[] = [];
  const flushLoose = (): void => {
    if (loose.some((n) => !(n.type === 'text' && n.text.trim() === ''))) {
      blocks.push({ kind: 'paragraph', runs: runsOf(loose, value, NO_MARKS, []) });
    }
    loose = [];
  };
  for (const n of nodes) {
    if (n.type === 'el' && n.tag === 'div') continue; // the logo node is drawn as letterhead
    if (n.type === 'el' && (n.tag === 'p' || n.tag === 'h2' || n.tag === 'ul' || n.tag === 'ol')) {
      flushLoose();
      if (n.tag === 'p') blocks.push({ kind: 'paragraph', runs: runsOf(n.children, value, NO_MARKS, []) });
      else if (n.tag === 'h2') blocks.push({ kind: 'heading', runs: runsOf(n.children, value, NO_MARKS, []) });
      else blocks.push({ kind: 'list', ordered: n.tag === 'ol', items: listItems(n, value) });
      continue;
    }
    loose.push(n);
  }
  flushLoose();
  return blocks;
}

// Structural parse of a stored field_schema as rtr-html-v1. Null on mismatch.
export function parseHtmlContent(fieldSchema: unknown): RtrTemplateContentHtmlV1 | null {
  if (typeof fieldSchema !== 'object' || fieldSchema === null || Array.isArray(fieldSchema)) return null;
  const o = fieldSchema as Record<string, unknown>;
  if (o.render_schema_version !== RTR_HTML_SCHEMA_V1) return null;
  if (typeof o.title !== 'string' || typeof o.html !== 'string') return null;
  const logo = parseLogoRef(o.logo);
  return { render_schema_version: RTR_HTML_SCHEMA_V1, title: o.title, html: o.html, logo };
}

export function parseLogoRef(raw: unknown): RtrHtmlLogoRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.asset_id !== 'string' || typeof l.sha256 !== 'string') return null;
  if (l.mime !== 'image/png' && l.mime !== 'image/jpeg') return null;
  return { asset_id: l.asset_id, sha256: l.sha256, mime: l.mime };
}
