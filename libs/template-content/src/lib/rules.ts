// TEMPLATE-CONTENT-2 (Aramo-Template-Content-2-Directive-v1_0-LOCKED) C-0 — the ONE set of rules
// for editable document template content. The server sanitiser (apps/api, authoritative) and
// every client (the Studio, SafeDoc, readiness) read these values; none restates them.
//
// Pure TypeScript ESM, no dependency (scope:shared, type:client-shared).

/** The editable-content versions. v2 is a strict superset of v1; v1 renders forever (C-1). */
export const RTR_HTML_V1 = 'rtr-html-v1';
export const RTR_HTML_V2 = 'rtr-html-v2';
/**
 * TEMPLATE-FIELDS-1 F-1 (ruling R-2) — v3 is a strict superset of v2 that adds ONE empty inline
 * marker, `<span data-sign-field="{field_key}"></span>`: a Sign field placed in the text. v1 and
 * v2 read and render exactly as before (their readers discard the marker).
 */
export const RTR_HTML_V3 = 'rtr-html-v3';
export const HTML_CONTENT_VERSIONS = [RTR_HTML_V1, RTR_HTML_V2, RTR_HTML_V3] as const;
export type HtmlContentVersion = (typeof HTML_CONTENT_VERSIONS)[number];

/** The version the Studio writes (C-4; F-1: v3). */
export const CURRENT_HTML_CONTENT_VERSION: HtmlContentVersion = RTR_HTML_V3;

/** Whether `v` is an editable-content version (any; readers accept every one, C-3). */
export function isHtmlContentVersion(v: unknown): v is HtmlContentVersion {
  return v === RTR_HTML_V1 || v === RTR_HTML_V2 || v === RTR_HTML_V3;
}

/** The ordinal of a version: v1 = 1, v2 = 2, v3 = 3. */
export function contentVersionOrdinal(v: HtmlContentVersion): number {
  return v === RTR_HTML_V3 ? 3 : v === RTR_HTML_V2 ? 2 : 1;
}

/** Whether `version` has the v2 features (h3 / h4, tables, hr, page breaks, 2-level lists): v2 and v3. */
export function hasV2Features(version: HtmlContentVersion): boolean {
  return contentVersionOrdinal(version) >= 2;
}

/** Whether `version` may carry inline Sign field markers (v3 only, F-1). */
export function allowsInlineFields(version: HtmlContentVersion): boolean {
  return version === RTR_HTML_V3;
}

/** v3 > v2 > v1: whether replacing `from` content with `to` content would lose features (C-6, F-1). */
export function isContentDowngrade(from: HtmlContentVersion, to: HtmlContentVersion): boolean {
  return contentVersionOrdinal(to) < contentVersionOrdinal(from);
}

// ── Block kinds ──────────────────────────────────────────────────────────────

/** The block kinds of each version. `page_break` is an `<hr data-break="page">`. */
export const BLOCK_KINDS_V1 = ['p', 'h2', 'ul', 'ol'] as const;
export const BLOCK_KINDS_V2 = ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'table', 'hr', 'page_break'] as const;
export type BlockKindV1 = (typeof BLOCK_KINDS_V1)[number];
export type BlockKindV2 = (typeof BLOCK_KINDS_V2)[number];

export function blockKindsOf(version: HtmlContentVersion): readonly string[] {
  return hasV2Features(version) ? BLOCK_KINDS_V2 : BLOCK_KINDS_V1;
}

/** The heading tags of each version, largest first. */
export const HEADING_TAGS_V1 = ['h2'] as const;
export const HEADING_TAGS_V2 = ['h2', 'h3', 'h4'] as const;
export type HeadingLevel = 2 | 3 | 4;

export function headingLevelOf(tag: string): HeadingLevel | null {
  return tag === 'h2' ? 2 : tag === 'h3' ? 3 : tag === 'h4' ? 4 : null;
}

// ── Allowed markup (the server sanitiser's allowlist) ────────────────────────

/** v1: exactly today's 13 tags (rtr-html-content.ts before this directive). */
export const ALLOWED_TAGS_V1 = ['p', 'h2', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'span', 'div'] as const;

/**
 * v2 adds h3, h4, a table (table / thead / tbody / tr / th / td; thead and tbody are accepted
 * because browsers insert them, and are unwrapped in the canonical form) and hr (a divider, or a
 * page break when it carries {@link PAGE_BREAK_ATTR}).
 */
export const ALLOWED_TAGS_V2 = [...ALLOWED_TAGS_V1, 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'] as const;

export function allowedTagsOf(version: HtmlContentVersion): readonly string[] {
  return hasV2Features(version) ? ALLOWED_TAGS_V2 : ALLOWED_TAGS_V1;
}

/** The only attributes content may carry (v2 adds the page-break marker on hr; v3 the field marker). */
export const VARIABLE_ATTR = 'data-field';
/** TEMPLATE-FIELDS-1 F-1 — the inline Sign field marker attribute (v3): `<span data-sign-field="key"></span>`. */
export const SIGN_FIELD_ATTR = 'data-sign-field';
export const ASSET_ATTR = 'data-asset';
export const PAGE_BREAK_ATTR = 'data-break';
export const PAGE_BREAK_VALUE = 'page';

export function allowedAttributesOf(version: HtmlContentVersion): Readonly<Record<string, readonly string[]>> {
  const base = { span: [VARIABLE_ATTR], div: [ASSET_ATTR] };
  if (allowsInlineFields(version)) return { span: [VARIABLE_ATTR, SIGN_FIELD_ATTR], div: [ASSET_ATTR], hr: [PAGE_BREAK_ATTR] };
  return hasV2Features(version) ? { ...base, hr: [PAGE_BREAK_ATTR] } : base;
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Content size cap in bytes (UTF-8), checked before and after sanitising (C-1, L-3). */
export const CONTENT_MAX_BYTES_V1 = 64 * 1024;
export const CONTENT_MAX_BYTES_V2 = 256 * 1024;

export function contentMaxBytesOf(version: HtmlContentVersion): number {
  return hasV2Features(version) ? CONTENT_MAX_BYTES_V2 : CONTENT_MAX_BYTES_V1;
}

/**
 * List nesting: v2 allows a list inside a list item, two levels in all. v1 stays as it was
 * (the server accepted any depth; the v1 client flattened nested lists).
 */
export const LIST_MAX_DEPTH_V2 = 2;

export function listMaxDepthOf(version: HtmlContentVersion): number {
  return hasV2Features(version) ? LIST_MAX_DEPTH_V2 : Number.POSITIVE_INFINITY;
}

/** Tables (v2): no merged cells, no nested tables, inline content only in cells. */
export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 200;

// ── Variables and typed placeholders ─────────────────────────────────────────

/**
 * The `{{key}}` token as typed in text (paste, imported text, clause text). One pattern for
 * every caller: before this directive the server held three copies and the clients two.
 */
export const PLACEHOLDER_TOKEN_SOURCE = String.raw`\{\{\s*([A-Za-z0-9_.]+)\s*\}\}`;

/** A fresh global RegExp for the token (callers never share `lastIndex`). */
export function placeholderTokenRe(): RegExp {
  return new RegExp(PLACEHOLDER_TOKEN_SOURCE, 'g');
}

/** The keys of every `{{key}}` token in `text`, in order (duplicates kept). */
export function placeholderKeysIn(text: string): string[] {
  return [...text.matchAll(placeholderTokenRe())].map((m) => m[1] as string);
}

/** The characters a variable key may use in content (a chip's `data-field`). */
export const CONTENT_KEY_RE = /^[A-Za-z0-9_.]+$/;

/** A catalog variable key as created on the platform: dotted lower-snake segments, ≤ 64. */
export const VARIABLE_CATALOG_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const VARIABLE_CATALOG_KEY_MAX = 64;

// ── Raw preview html in a sandboxed iframe (C-11) ────────────────────────────

/**
 * The minimal table / divider / page-break styles for a host that shows the server's preview
 * html in a sandboxed iframe (no scripts; CSS only). Only these rules are added, so v1 content
 * looks exactly as before.
 */
export const CONTENT_PREVIEW_IFRAME_STYLE =
  '<style>table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 10px}' +
  'th,td{border:1px solid #c9d2d8;padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}' +
  'th{background:#f3f5f7;font-weight:700}hr{border:0;border-top:1px solid #c9d2d8;margin:12px 0}' +
  'hr[data-break="page"]{border-top:1px dashed #93a0a8;margin:18px 0}li>ul,li>ol{margin:2px 0 0}</style>';

/** Preview html for a sandboxed iframe's srcDoc, with CONTENT_PREVIEW_IFRAME_STYLE in front. */
export function contentPreviewIframeDoc(html: string): string {
  return CONTENT_PREVIEW_IFRAME_STYLE + html;
}

// ── Refusal reasons (C-3.8; stable) ──────────────────────────────────────────

export const CONTENT_REFUSAL_REASONS = [
  'unsupported_content_version',
  'content_version_downgrade',
  'content_too_large',
  'table_too_large',
  'list_too_deep',
  'unresolved_placeholder',
] as const;
export type ContentRefusalReason = (typeof CONTENT_REFUSAL_REASONS)[number];

// ── Inline Sign fields (TEMPLATE-FIELDS-1 F-1, F-2; §3.7) ───────────────────

/**
 * The field-key rule a marker's key follows: the platform field catalog's key rule (lower snake
 * case, ≤ 64; the same rule as the fixed-form Form Studio's field keys).
 */
export const INLINE_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isInlineFieldKey(key: unknown): key is string {
  return typeof key === 'string' && INLINE_FIELD_KEY_RE.test(key);
}

/**
 * F-2 / R-7 — the blocks a marker may sit in (its nearest block): paragraphs, list items and table
 * cells. Never a heading or the title (a marker anywhere else is refused, field_position_not_allowed).
 * Marks (b / i / u) between the block and the marker are fine.
 */
export const INLINE_FIELD_BLOCKS = ['p', 'li', 'td', 'th'] as const;

/** Whether a marker whose nearest block tag is `blockTag` is in an allowed place. */
export function inlineFieldAllowedIn(blockTag: string | null): boolean {
  return blockTag !== null && (INLINE_FIELD_BLOCKS as readonly string[]).includes(blockTag);
}

/** The marker html for `key` (canonical: empty, only the attribute). */
export function inlineFieldMarkerHtml(key: string): string {
  return `<span ${SIGN_FIELD_ATTR}="${key}"></span>`;
}

/** §3.7 — the refusal reasons of inline fields (new, stable). */
export const INLINE_FIELD_REFUSAL_REASONS = [
  'field_position_not_allowed',
  'field_marker_mismatch',
  'field_marker_duplicate',
  'signing_roles_required',
  'field_too_wide',
  'field_not_placed',
  'fields_platform_only',
  'inline_fields_not_supported_for_ats',
] as const;
export type InlineFieldRefusalReason = (typeof INLINE_FIELD_REFUSAL_REASONS)[number];

// ── Client sanitiser markup tables (F-4: one place, D-4) ────────────────────

/** Inline marks and the canonical tag each one is stored as (strong → b, em → i). */
export const INLINE_MARK_TAGS: Readonly<Record<string, 'b' | 'i' | 'u'>> = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u' };

/** Elements a client drops WITH their content when reading foreign html (never surfaced as text). */
export const DROPPED_WITH_CONTENT_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'math',
  'img', 'picture', 'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'option', 'frame', 'frameset', 'base',
] as const;

/** Block-like elements of foreign html: unwrapped by a client, with a line break kept between them. */
export const BLOCK_LIKE_TAGS = [
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'section', 'article', 'header', 'footer',
  'table', 'tbody', 'thead', 'tr', 'td', 'th', 'aside', 'main', 'nav', 'figure', 'address', 'dl', 'dt', 'dd', 'hr',
] as const;

/** The server sample preview's attributes (never stored): a variable's sample, an inline field's box. */
export const SAMPLE_ATTR = 'data-sample';
export const SIGN_FIELD_SAMPLE_ATTR = 'data-sign-field-sample';
