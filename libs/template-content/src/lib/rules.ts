// TEMPLATE-CONTENT-2 (Aramo-Template-Content-2-Directive-v1_0-LOCKED) C-0 — the ONE set of rules
// for editable document template content. The server sanitiser (apps/api, authoritative) and
// every client (the Studio, SafeDoc, readiness) read these values; none restates them.
//
// Pure TypeScript ESM, no dependency (scope:shared, type:client-shared).

/** The editable-content versions. v2 is a strict superset of v1; v1 renders forever (C-1). */
export const RTR_HTML_V1 = 'rtr-html-v1';
export const RTR_HTML_V2 = 'rtr-html-v2';
export const HTML_CONTENT_VERSIONS = [RTR_HTML_V1, RTR_HTML_V2] as const;
export type HtmlContentVersion = (typeof HTML_CONTENT_VERSIONS)[number];

/** The version the Studio writes (C-4). */
export const CURRENT_HTML_CONTENT_VERSION: HtmlContentVersion = RTR_HTML_V2;

/** Whether `v` is an editable-content version (either; readers accept both, C-3). */
export function isHtmlContentVersion(v: unknown): v is HtmlContentVersion {
  return v === RTR_HTML_V1 || v === RTR_HTML_V2;
}

/** v2 > v1: whether replacing `from` content with `to` content would lose features (C-6). */
export function isContentDowngrade(from: HtmlContentVersion, to: HtmlContentVersion): boolean {
  return from === RTR_HTML_V2 && to === RTR_HTML_V1;
}

// ── Block kinds ──────────────────────────────────────────────────────────────

/** The block kinds of each version. `page_break` is an `<hr data-break="page">`. */
export const BLOCK_KINDS_V1 = ['p', 'h2', 'ul', 'ol'] as const;
export const BLOCK_KINDS_V2 = ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'table', 'hr', 'page_break'] as const;
export type BlockKindV1 = (typeof BLOCK_KINDS_V1)[number];
export type BlockKindV2 = (typeof BLOCK_KINDS_V2)[number];

export function blockKindsOf(version: HtmlContentVersion): readonly string[] {
  return version === RTR_HTML_V2 ? BLOCK_KINDS_V2 : BLOCK_KINDS_V1;
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
  return version === RTR_HTML_V2 ? ALLOWED_TAGS_V2 : ALLOWED_TAGS_V1;
}

/** The only attributes content may carry (v2 adds the page-break marker on hr). */
export const VARIABLE_ATTR = 'data-field';
export const ASSET_ATTR = 'data-asset';
export const PAGE_BREAK_ATTR = 'data-break';
export const PAGE_BREAK_VALUE = 'page';

export function allowedAttributesOf(version: HtmlContentVersion): Readonly<Record<string, readonly string[]>> {
  const base = { span: [VARIABLE_ATTR], div: [ASSET_ATTR] };
  return version === RTR_HTML_V2 ? { ...base, hr: [PAGE_BREAK_ATTR] } : base;
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Content size cap in bytes (UTF-8), checked before and after sanitising (C-1, L-3). */
export const CONTENT_MAX_BYTES_V1 = 64 * 1024;
export const CONTENT_MAX_BYTES_V2 = 256 * 1024;

export function contentMaxBytesOf(version: HtmlContentVersion): number {
  return version === RTR_HTML_V2 ? CONTENT_MAX_BYTES_V2 : CONTENT_MAX_BYTES_V1;
}

/**
 * List nesting: v2 allows a list inside a list item, two levels in all. v1 stays as it was
 * (the server accepted any depth; the v1 client flattened nested lists).
 */
export const LIST_MAX_DEPTH_V2 = 2;

export function listMaxDepthOf(version: HtmlContentVersion): number {
  return version === RTR_HTML_V2 ? LIST_MAX_DEPTH_V2 : Number.POSITIVE_INFINITY;
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
