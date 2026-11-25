import sanitizeHtml from 'sanitize-html';
import { type InlineFieldPlace, type RichBlock, type RichListItem, type RichRun } from '@aramo/documents-rendering';
import {
  CONTENT_KEY_RE,
  SIGN_FIELD_ATTR,
  SIGN_FIELD_SAMPLE_ATTR,
  allowsInlineFields,
  inlineFieldAllowedIn,
  isInlineFieldKey,
  CURRENT_HTML_CONTENT_VERSION,
  PAGE_BREAK_ATTR,
  PAGE_BREAK_VALUE,
  RTR_HTML_V1,
  RTR_HTML_V2,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  allowedAttributesOf,
  allowedTagsOf,
  contentMaxBytesOf,
  headingLevelOf,
  isHtmlContentVersion,
  listMaxDepthOf,
  placeholderTokenRe,
  type HtmlContentVersion,
} from '@aramo/template-content';

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

// TEMPLATE-CONTENT-2 C-0/C-1 — the versions and limits come from @aramo/template-content. v2 is a
// strict superset of v1 (h3/h4, simple tables, hr, page break, 2-level lists, 256 KiB); v1
// content is sanitised and rendered exactly as before, forever.
export const RTR_HTML_SCHEMA_V1 = RTR_HTML_V1;
export const RTR_HTML_SCHEMA_V2 = RTR_HTML_V2;
/** The v1 cap (kept for existing callers); per-version caps come from contentMaxBytesOf. */
export const RTR_HTML_MAX_BYTES = contentMaxBytesOf(RTR_HTML_V1);
export const TENANT_LOGO_ASSET = 'tenant.logo';

export interface RtrHtmlLogoRef {
  asset_id: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg';
}

// Editable (html) content of either version. The name is historical: since TEMPLATE-CONTENT-2
// it also carries rtr-html-v2 content (the shape is the same; only the allowed markup grows).
export interface RtrTemplateContentHtmlV1 {
  render_schema_version: HtmlContentVersion;
  title: string;
  html: string;
  logo?: RtrHtmlLogoRef | null;
  // Amendment M-A6 (LOCKED) §3.2 — the template's signing roles. Optional: content without
  // it behaves exactly as before (the single talent block) and serialises byte-identically.
  // Frozen and fingerprinted with the rest of field_schema.
  signing?: RtrSigningConfig;
}

// ── Signing roles (Amendment M-A6 §3.2) ────────────────────────────────────────────
export const SIGNING_ROLE_KINDS = ['SIGNER', 'CC'] as const;
export type SigningRoleKind = (typeof SIGNING_ROLE_KINDS)[number];
export const SIGNING_ROUTING_MODES = ['PARALLEL', 'SEQUENTIAL'] as const;
export type SigningRoutingMode = (typeof SIGNING_ROUTING_MODES)[number];
// Sign limits (M-A5 §1.4): at most 10 signing and 10 copy recipients per envelope.
export const MAX_SIGNER_ROLES = 10;
export const MAX_CC_ROLES = 10;
export const MAX_ROLE_LABEL = 60;
export const MAX_DEFAULT_SUBJECT = 200;
export const MAX_DEFAULT_MESSAGE = 1000;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Printable Latin-1 only: the renderer draws role labels with the standard PDF fonts.
const ROLE_LABEL_RE = /^[\x20-\x7e\u00a0-\u00ff]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface RtrSigningRole {
  role_key: string;
  label: string;
  kind: SigningRoleKind;
  order: number;
}

export interface RtrSigningConfig {
  roles: RtrSigningRole[];
  routing_mode: SigningRoutingMode;
  default_subject?: string;
  default_message?: string;
}

// Validate + canonicalise a `signing` member: roles sorted by order, fixed key order,
// trimmed text, absent defaults omitted. Rules: 1..10 SIGNER roles, 0..10 CC roles,
// role_key unique (lower snake case), order a distinct integer >= 1, label 1..60
// printable characters, routing_mode PARALLEL | SEQUENTIAL. Returns the first issue.
export function parseSigningConfig(raw: unknown): { signing: RtrSigningConfig } | { issue: string; index?: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { issue: 'signing_not_object' };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!['roles', 'routing_mode', 'default_subject', 'default_message'].includes(k)) return { issue: 'signing_unknown_member' };
  }
  if (!Array.isArray(o.roles) || o.roles.length === 0) return { issue: 'signing_roles_required' };
  if (o.roles.length > MAX_SIGNER_ROLES + MAX_CC_ROLES) return { issue: 'signing_too_many_roles' };
  const roles: RtrSigningRole[] = [];
  const keys = new Set<string>();
  const orders = new Set<number>();
  for (const [index, r] of o.roles.entries()) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { issue: 'signing_role_invalid', index };
    const rr = r as Record<string, unknown>;
    for (const k of Object.keys(rr)) {
      if (!['role_key', 'label', 'kind', 'order'].includes(k)) return { issue: 'signing_role_unknown_member', index };
    }
    if (typeof rr.role_key !== 'string' || !ROLE_KEY_RE.test(rr.role_key)) return { issue: 'signing_role_key_invalid', index };
    if (keys.has(rr.role_key)) return { issue: 'signing_role_key_duplicate', index };
    const label = typeof rr.label === 'string' ? rr.label.trim() : '';
    if (label.length === 0 || label.length > MAX_ROLE_LABEL || !ROLE_LABEL_RE.test(label)) return { issue: 'signing_role_label_invalid', index };
    if (rr.kind !== 'SIGNER' && rr.kind !== 'CC') return { issue: 'signing_role_kind_invalid', index };
    if (typeof rr.order !== 'number' || !Number.isInteger(rr.order) || rr.order < 1 || rr.order > 1000) return { issue: 'signing_role_order_invalid', index };
    if (orders.has(rr.order)) return { issue: 'signing_role_order_duplicate', index };
    keys.add(rr.role_key);
    orders.add(rr.order);
    roles.push({ role_key: rr.role_key, label, kind: rr.kind, order: rr.order });
  }
  const signers = roles.filter((r) => r.kind === 'SIGNER').length;
  if (signers === 0) return { issue: 'signing_signer_role_required' };
  if (signers > MAX_SIGNER_ROLES) return { issue: 'signing_too_many_signer_roles' };
  if (roles.length - signers > MAX_CC_ROLES) return { issue: 'signing_too_many_cc_roles' };
  if (o.routing_mode !== 'PARALLEL' && o.routing_mode !== 'SEQUENTIAL') return { issue: 'signing_routing_mode_invalid' };
  const out: RtrSigningConfig = { roles: [...roles].sort((a, b) => a.order - b.order), routing_mode: o.routing_mode };
  for (const [key, max] of [
    ['default_subject', MAX_DEFAULT_SUBJECT],
    ['default_message', MAX_DEFAULT_MESSAGE],
  ] as const) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || CONTROL_RE.test(v)) return { issue: `signing_${key}_invalid` };
    const t = v.trim();
    if (t.length > max) return { issue: `signing_${key}_too_long` };
    if (t.length > 0) out[key] = t;
  }
  return { signing: out };
}

// The SIGNER roles of a content version in signing order (empty without `signing`).
export function signerRoles(content: { signing?: RtrSigningConfig }): RtrSigningRole[] {
  return (content.signing?.roles ?? []).filter((r) => r.kind === 'SIGNER');
}

export type RtrTemplateContent = RtrTemplateContentV1 | RtrTemplateContentHtmlV1;

export type RtrTemplateContentHtml = RtrTemplateContentHtmlV1;

/** Editable html content of either version (C-3: every reader accepts v1 and v2). */
export function isHtmlContent(c: RtrTemplateContent): c is RtrTemplateContentHtmlV1 {
  return isHtmlContentVersion(c.render_schema_version);
}

// ── Sanitiser (authoritative) ────────────────────────────────────────────────────
function sanitizeOptions(version: HtmlContentVersion): sanitizeHtml.IOptions {
  return {
  allowedTags: [...allowedTagsOf(version)],
  allowedAttributes: Object.fromEntries(Object.entries(allowedAttributesOf(version)).map(([t, a]) => [t, [...a]])),
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
}

// ── Minimal tree over SANITISED output only ────────────────────────────────────────
// sanitize-html's output contains only allowlisted tags with only data-field/data-asset
// attributes and entity-escaped text, so this small tokenizer is total over it.
export type HtmlNode =
  | { type: 'text'; text: string }
  | { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

const VOID_TAGS = new Set(['br', 'hr']);

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
// TEMPLATE-CONTENT-2 C-2 (v2 only reaches the new tags; v1 discards them in sanitize-html):
//   - hr keeps only data-break="page" (a page break); any other value is a plain divider;
//   - a table keeps only its rows (thead / tbody are unwrapped, as browsers insert them), a
//     row only its th / td cells, and a cell only INLINE content (blocks inside a cell are
//     unwrapped and separated by a line break; nested tables become their text);
//   - tr / th / td outside a table are unwrapped; an empty table is dropped.
const CELL_BLOCKS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

function canonicalise(nodes: readonly HtmlNode[], inCell = false): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push(n);
      continue;
    }
    if (n.tag === 'span') {
      // TEMPLATE-FIELDS-1 F-2 — the inline Sign field marker (v3 only: sanitize-html keeps the
      // attribute only for v3): canonical = empty, only the attribute. Never a variable.
      const marker = n.attrs[SIGN_FIELD_ATTR];
      if (marker !== undefined && marker.length > 0) {
        out.push({ type: 'el', tag: 'span', attrs: { [SIGN_FIELD_ATTR]: marker }, children: [] });
        continue;
      }
      const key = n.attrs['data-field'];
      if (key !== undefined && key.length > 0) out.push({ type: 'el', tag: 'span', attrs: { 'data-field': key }, children: [] });
      else out.push(...canonicalise(n.children, inCell));
      continue;
    }
    if (n.tag === 'div') {
      if (n.attrs['data-asset'] !== undefined) out.push({ type: 'el', tag: 'div', attrs: { 'data-asset': n.attrs['data-asset'] }, children: [] });
      else out.push(...canonicalise(n.children, inCell));
      continue;
    }
    if (n.tag === 'hr') {
      if (inCell) continue;
      out.push({ type: 'el', tag: 'hr', attrs: n.attrs[PAGE_BREAK_ATTR] === PAGE_BREAK_VALUE ? { [PAGE_BREAK_ATTR]: PAGE_BREAK_VALUE } : {}, children: [] });
      continue;
    }
    if (inCell && CELL_BLOCKS.has(n.tag)) {
      // A block inside a table cell: keep its inline content, one line per block.
      const inner = canonicalise(n.children, true);
      if (inner.length > 0) {
        if (out.length > 0) out.push({ type: 'el', tag: 'br', attrs: {}, children: [] });
        out.push(...inner);
      }
      continue;
    }
    if (n.tag === 'table') {
      const rows = tableRows(n);
      if (rows.length > 0) out.push({ type: 'el', tag: 'table', attrs: {}, children: rows });
      continue;
    }
    if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tr' || n.tag === 'th' || n.tag === 'td') {
      out.push(...canonicalise(n.children, inCell));
      continue;
    }
    out.push({ type: 'el', tag: n.tag, attrs: {}, children: canonicalise(n.children, inCell) });
  }
  return out;
}

function tableRows(table: HtmlNode & { type: 'el' }): HtmlNode[] {
  const rows: HtmlNode[] = [];
  const collect = (ns: readonly HtmlNode[]): void => {
    for (const c of ns) {
      if (c.type !== 'el') continue;
      if (c.tag === 'thead' || c.tag === 'tbody') collect(c.children);
      else if (c.tag === 'tr') {
        const cells = c.children
          .filter((x): x is HtmlNode & { type: 'el' } => x.type === 'el' && (x.tag === 'th' || x.tag === 'td'))
          .map((x) => ({ type: 'el' as const, tag: x.tag, attrs: {}, children: canonicalise(x.children, true) }));
        if (cells.length > 0) rows.push({ type: 'el', tag: 'tr', attrs: {}, children: cells });
      }
    }
  };
  collect(table.children);
  return rows;
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
  reason:
    | 'unknown_field'
    | 'logo_position'
    | 'content_too_large'
    | 'unknown_asset'
    | 'table_too_large'
    | 'list_too_deep'
    // TEMPLATE-FIELDS-1 F-2 / F-3.
    | 'field_position_not_allowed'
    | 'field_marker_duplicate'
    | 'field_marker_mismatch';
  keys?: string[];
}

// ── Inline Sign field markers (TEMPLATE-FIELDS-1 F-2) ─────────────────────────────

/** One marker in the canonical tree: its key, the block it sits in, and the space it may use. */
export interface InlineFieldMarker {
  key: string;
  /** The nearest block: p, li, td, th, a heading tag, or null (loose top-level content). */
  block: string | null;
  /** The renderer's width context (null where a marker is not allowed). */
  place: InlineFieldPlace | null;
}

const MARKER_BLOCK_TAGS = new Set(['p', 'li', 'td', 'th', 'h2', 'h3', 'h4']);

/** Every marker in document order (duplicates kept), with where it sits. */
export function collectInlineFieldMarkers(nodes: readonly HtmlNode[]): InlineFieldMarker[] {
  const out: InlineFieldMarker[] = [];
  const walk = (ns: readonly HtmlNode[], block: string | null, place: InlineFieldPlace | null, listLevel: number, tableCols: number): void => {
    for (const n of ns) {
      if (n.type !== 'el') continue;
      if (n.tag === 'span' && n.attrs[SIGN_FIELD_ATTR] !== undefined) {
        out.push({ key: n.attrs[SIGN_FIELD_ATTR] as string, block, place: inlineFieldAllowedIn(block) ? place : null });
        continue;
      }
      if (n.tag === 'ul' || n.tag === 'ol') {
        walk(n.children, block, place, listLevel + 1, tableCols);
        continue;
      }
      if (n.tag === 'table') {
        const cols = Math.max(1, ...n.children.map((r) => (r.type === 'el' ? r.children.length : 0)));
        walk(n.children, block, place, listLevel, cols);
        continue;
      }
      if (n.tag === 'li') {
        walk(n.children, 'li', { in: 'list', level: Math.max(0, listLevel - 1) }, listLevel, tableCols);
        continue;
      }
      if (n.tag === 'td' || n.tag === 'th') {
        walk(n.children, n.tag, { in: 'table', columns: tableCols }, listLevel, tableCols);
        continue;
      }
      if (MARKER_BLOCK_TAGS.has(n.tag)) {
        // A paragraph keeps the width of what holds it (a list item); on its own, the content width.
        const p: InlineFieldPlace | null = n.tag === 'p' ? (place ?? { in: 'paragraph' }) : place;
        // A heading is never an allowed place, whatever holds it.
        walk(n.children, n.tag === 'p' && block !== null && /^h[234]$/.test(block) ? block : n.tag, p, listLevel, tableCols);
        continue;
      }
      walk(n.children, block, place, listLevel, tableCols);
    }
  };
  walk(nodes, null, null, 0, 1);
  return out;
}

/** F-2 / F-3 — the first marker issue of canonical content: bad key, bad place, duplicate. */
function markerIssue(nodes: readonly HtmlNode[]): HtmlValidationIssue | null {
  const markers = collectInlineFieldMarkers(nodes);
  if (markers.length === 0) return null;
  const invalid = markers.filter((m) => !isInlineFieldKey(m.key)).map((m) => m.key);
  if (invalid.length > 0) return { reason: 'field_marker_mismatch', keys: [...new Set(invalid)] };
  const misplaced = markers.filter((m) => m.place === null).map((m) => m.key);
  if (misplaced.length > 0) return { reason: 'field_position_not_allowed', keys: [...new Set(misplaced)] };
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of markers) (seen.has(m.key) ? dup : seen).add(m.key);
  if (dup.size > 0) return { reason: 'field_marker_duplicate', keys: [...dup] };
  return null;
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
// TEMPLATE-CONTENT-2 C-1 — table and list limits (v2). The first issue found, or null.
function structureIssue(nodes: readonly HtmlNode[], version: HtmlContentVersion): HtmlValidationIssue | null {
  const maxDepth = listMaxDepthOf(version);
  const walk = (ns: readonly HtmlNode[], listDepth: number): HtmlValidationIssue | null => {
    for (const n of ns) {
      if (n.type !== 'el') continue;
      if (n.tag === 'table') {
        const widest = Math.max(0, ...n.children.map((r) => (r.type === 'el' ? r.children.length : 0)));
        if (n.children.length > TABLE_MAX_ROWS || widest > TABLE_MAX_COLUMNS) return { reason: 'table_too_large' };
      }
      const depth = n.tag === 'ul' || n.tag === 'ol' ? listDepth + 1 : listDepth;
      if (depth > maxDepth) return { reason: 'list_too_deep' };
      const inner = walk(n.children, depth);
      if (inner !== null) return inner;
    }
    return null;
  };
  return walk(nodes, 0);
}

export function sanitizeRtrHtml(
  html: string,
  isKnownKey: (key: string) => boolean = isRtrBindingKey,
  version: HtmlContentVersion = RTR_HTML_V1,
): { html: string; nodes: HtmlNode[] } | { issue: HtmlValidationIssue } {
  const maxBytes = contentMaxBytesOf(version);
  if (Buffer.byteLength(html, 'utf8') > maxBytes) return { issue: { reason: 'content_too_large' } };
  const cleaned = sanitizeHtml(html, sanitizeOptions(version));
  const nodes = canonicalise(parseSanitized(cleaned));
  const unknown = [...new Set(collectFieldKeys(nodes).filter((k) => !isKnownKey(k)))];
  if (unknown.length > 0) return { issue: { reason: 'unknown_field', keys: unknown } };
  const assets = countAssets(nodes);
  if (assets.nonTenantLogo.length > 0) return { issue: { reason: 'unknown_asset', keys: assets.nonTenantLogo } };
  if (assets.count > 1 || (assets.count === 1 && !hasLogoNode(nodes))) return { issue: { reason: 'logo_position' } };
  const structure = structureIssue(nodes, version);
  if (structure !== null) return { issue: structure };
  if (allowsInlineFields(version)) {
    const marker = markerIssue(nodes);
    if (marker !== null) return { issue: marker };
  }
  const out = serialize(nodes);
  if (Buffer.byteLength(out, 'utf8') > maxBytes) return { issue: { reason: 'content_too_large' } };
  return { html: out, nodes };
}

// ── Typed placeholders (TEMPLATE-CONTENT-2 C-16 / C-17) ─────────────────────────────
// A `{{key}}` typed as TEXT prints literally. On save, a typed token whose key is known becomes
// a chip; at publish / activate, any typed token left is refused (unresolved_placeholder).

/** Text tokens become chips where `isKnownKey(key)`; unknown tokens stay as text. */
export function chipKnownTypedTokens(nodes: readonly HtmlNode[], isKnownKey: (key: string) => boolean): HtmlNode[] {
  return nodes.flatMap((n): HtmlNode[] => {
    if (n.type === 'el') return [{ ...n, children: chipKnownTypedTokens(n.children, isKnownKey) }];
    const out: HtmlNode[] = [];
    let last = 0;
    for (const m of n.text.matchAll(placeholderTokenRe())) {
      const key = m[1] as string;
      if (!isKnownKey(key) || !CONTENT_KEY_RE.test(key)) continue;
      if ((m.index ?? 0) > last) out.push({ type: 'text', text: n.text.slice(last, m.index) });
      out.push({ type: 'el', tag: 'span', attrs: { 'data-field': key }, children: [] });
      last = (m.index ?? 0) + m[0].length;
    }
    if (last === 0) return [n];
    if (last < n.text.length) out.push({ type: 'text', text: n.text.slice(last) });
    return out;
  });
}

/** The keys of every `{{key}}` still typed as text, in order, without duplicates. */
export function typedPlaceholderKeys(nodes: readonly HtmlNode[]): string[] {
  const keys: string[] = [];
  const walk = (ns: readonly HtmlNode[]): void => {
    for (const n of ns) {
      if (n.type === 'text') for (const m of n.text.matchAll(placeholderTokenRe())) keys.push(m[1] as string);
      else walk(n.children);
    }
  };
  walk(nodes);
  return [...new Set(keys)];
}

// ── v1 → rtr-html-v1 conversion (draft creation, A1 §2.1) ──────────────────────────
function textToHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(placeholderTokenRe())) {
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
  // TEMPLATE-CONTENT-2 C-4 — a new html draft (adopt / generated → html) is written in the
  // current version.
  return { render_schema_version: CURRENT_HTML_CONTENT_VERSION, title: content.title, html, logo: null };
}

// ── Sample preview html (A1 / coordinator contract §7) ─────────────────────────────
// TEMPLATE-FIELDS-1 F-13 — `fieldLabel` names an inline field for the preview ("Signature ·
// Employee"): each marker becomes `<span data-sign-field-sample="key">label</span>`, which the
// clients draw as a labelled box. Without it (or for an unknown key) the label is the key.
export function htmlWithSamples(nodes: readonly HtmlNode[], sample: (key: string) => string, fieldLabel?: (key: string) => string | null): string {
  const map = (ns: readonly HtmlNode[]): HtmlNode[] =>
    ns.map((n) => {
      if (n.type === 'el' && n.tag === 'span' && n.attrs[SIGN_FIELD_ATTR] !== undefined) {
        const key = n.attrs[SIGN_FIELD_ATTR] as string;
        const label = fieldLabel?.(key) ?? key;
        return { type: 'el', tag: 'span', attrs: { [SIGN_FIELD_SAMPLE_ATTR]: key }, children: [{ type: 'text', text: label }] };
      }
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

/** F-8 — the box size of an inline field (the domain's catalog default for its type), or null. */
export type InlineFieldBox = (key: string) => { width: number; height: number } | null;

/** A marker reached the render model without a box size (no row / not placeable). */
export class InlineFieldNotPlacedError extends Error {
  constructor(public readonly field_key: string) {
    super(`field_not_placed: ${field_key}`);
    this.name = 'InlineFieldNotPlacedError';
  }
}

let currentBox: InlineFieldBox | undefined;

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
        const marker = n.attrs[SIGN_FIELD_ATTR];
        if (marker !== undefined) {
          // F-8 — an inline field box; a marker without a size is never dropped silently.
          const box = currentBox?.(marker) ?? null;
          if (box === null) throw new InlineFieldNotPlacedError(marker);
          out.push({ kind: 'field', field_key: marker, width: box.width, height: box.height });
          break;
        }
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

function tableBlock(table: HtmlNode & { type: 'el' }, value: (key: string) => string): RichBlock {
  const rows = table.children.filter((r): r is HtmlNode & { type: 'el' } => r.type === 'el' && r.tag === 'tr');
  const header = rows.length > 0 && (rows[0] as HtmlNode & { type: 'el' }).children.every((c) => c.type === 'el' && c.tag === 'th');
  return {
    kind: 'table',
    header,
    rows: rows.map((r) => r.children.filter((c): c is HtmlNode & { type: 'el' } => c.type === 'el').map((c) => runsOf(c.children, value, NO_MARKS, []))),
  };
}

const TOP_BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'table', 'hr']);

export function toRichBlocks(nodes: readonly HtmlNode[], value: (key: string) => string, box?: InlineFieldBox): RichBlock[] {
  const prev = currentBox;
  currentBox = box;
  try {
    return toRichBlocksInner(nodes, value);
  } finally {
    currentBox = prev;
  }
}

function toRichBlocksInner(nodes: readonly HtmlNode[], value: (key: string) => string): RichBlock[] {
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
    if (n.type === 'el' && TOP_BLOCK_TAGS.has(n.tag)) {
      flushLoose();
      const level = headingLevelOf(n.tag);
      if (n.tag === 'p') blocks.push({ kind: 'paragraph', runs: runsOf(n.children, value, NO_MARKS, []) });
      else if (level === 2) blocks.push({ kind: 'heading', runs: runsOf(n.children, value, NO_MARKS, []) });
      else if (level === 3 || level === 4) blocks.push({ kind: 'heading', runs: runsOf(n.children, value, NO_MARKS, []), level });
      else if (n.tag === 'table') blocks.push(tableBlock(n, value));
      else if (n.tag === 'hr') blocks.push(n.attrs[PAGE_BREAK_ATTR] === PAGE_BREAK_VALUE ? { kind: 'page_break' } : { kind: 'rule' });
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
  const version = o.render_schema_version;
  if (!isHtmlContentVersion(version)) return null;
  if (typeof o.title !== 'string' || typeof o.html !== 'string') return null;
  const logo = parseLogoRef(o.logo);
  // M-A6 §3.2 — `signing` is kept and validated; an invalid one fails the parse closed.
  if (o.signing !== undefined) {
    const sg = parseSigningConfig(o.signing);
    if ('issue' in sg) return null;
    return { render_schema_version: version, title: o.title, html: o.html, logo, signing: sg.signing };
  }
  return { render_schema_version: version, title: o.title, html: o.html, logo };
}

export function parseLogoRef(raw: unknown): RtrHtmlLogoRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.asset_id !== 'string' || typeof l.sha256 !== 'string') return null;
  if (l.mime !== 'image/png' && l.mime !== 'image/jpeg') return null;
  return { asset_id: l.asset_id, sha256: l.sha256, mime: l.mime };
}
