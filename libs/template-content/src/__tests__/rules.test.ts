// TEMPLATE-CONTENT-2 C-0 — the one set of editable-content rules.
import {
  ALLOWED_TAGS_V1,
  ALLOWED_TAGS_V2,
  CONTENT_MAX_BYTES_V1,
  CONTENT_MAX_BYTES_V2,
  CURRENT_HTML_CONTENT_VERSION,
  RTR_HTML_V1,
  RTR_HTML_V2,
  RTR_HTML_V3,
  INLINE_FIELD_REFUSAL_REASONS,
  allowsInlineFields,
  inlineFieldAllowedIn,
  inlineFieldMarkerHtml,
  isInlineFieldKey,
  allowedAttributesOf,
  allowedTagsOf,
  blockKindsOf,
  contentMaxBytesOf,
  headingLevelOf,
  isContentDowngrade,
  isHtmlContentVersion,
  listMaxDepthOf,
  placeholderKeysIn,
  placeholderTokenRe,
} from '../index.js';

describe('editable template content rules', () => {
  // TEMPLATE-FIELDS-1 F-1 — v3 is a strict superset of v2 with one marker; downgrade guard v3 > v2 > v1.
  it('v3 is a strict superset of v2 that adds only the inline field marker', () => {
    expect(isHtmlContentVersion(RTR_HTML_V3)).toBe(true);
    expect(allowedTagsOf(RTR_HTML_V3)).toEqual(allowedTagsOf(RTR_HTML_V2));
    expect(blockKindsOf(RTR_HTML_V3)).toEqual(blockKindsOf(RTR_HTML_V2));
    expect(contentMaxBytesOf(RTR_HTML_V3)).toBe(CONTENT_MAX_BYTES_V2);
    expect(listMaxDepthOf(RTR_HTML_V3)).toBe(2);
    expect(allowedAttributesOf(RTR_HTML_V3)).toEqual({ span: ['data-field', 'data-sign-field'], div: ['data-asset'], hr: ['data-break'] });
    expect([allowsInlineFields(RTR_HTML_V1), allowsInlineFields(RTR_HTML_V2), allowsInlineFields(RTR_HTML_V3)]).toEqual([false, false, true]);
  });

  it('downgrade guard: v3 > v2 > v1', () => {
    expect(isContentDowngrade(RTR_HTML_V3, RTR_HTML_V2)).toBe(true);
    expect(isContentDowngrade(RTR_HTML_V3, RTR_HTML_V1)).toBe(true);
    expect(isContentDowngrade(RTR_HTML_V2, RTR_HTML_V3)).toBe(false);
    expect(isContentDowngrade(RTR_HTML_V1, RTR_HTML_V3)).toBe(false);
    expect(isContentDowngrade(RTR_HTML_V3, RTR_HTML_V3)).toBe(false);
  });

  it('the marker: its key rule, its places and its stable refusal reasons', () => {
    expect(inlineFieldMarkerHtml('employee_signature')).toBe('<span data-sign-field="employee_signature"></span>');
    expect(['sig_1', 'a'].map(isInlineFieldKey)).toEqual([true, true]);
    expect(['', '1abc', 'Sig', 'a.b', 'a-b', 'x'.repeat(65), 7].map(isInlineFieldKey)).toEqual([false, false, false, false, false, false, false]);
    expect(['p', 'li', 'td', 'th'].map(inlineFieldAllowedIn)).toEqual([true, true, true, true]);
    expect(['h2', 'h3', 'h4', 'ul', null].map(inlineFieldAllowedIn)).toEqual([false, false, false, false, false]);
    expect([...INLINE_FIELD_REFUSAL_REASONS]).toEqual([
      'field_position_not_allowed',
      'field_marker_mismatch',
      'field_marker_duplicate',
      'signing_roles_required',
      'field_too_wide',
      'field_not_placed',
      'fields_platform_only',
      'inline_fields_not_supported_for_ats',
    ]);
  });

  it('v1 is exactly the pre-v2 allowlist; v2 is a strict superset', () => {
    expect([...ALLOWED_TAGS_V1]).toEqual(['p', 'h2', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'span', 'div']);
    for (const t of ALLOWED_TAGS_V1) expect(ALLOWED_TAGS_V2).toContain(t);
    expect(allowedTagsOf(RTR_HTML_V2)).toEqual(expect.arrayContaining(['h3', 'h4', 'table', 'tr', 'th', 'td', 'hr']));
    for (const k of blockKindsOf(RTR_HTML_V1)) expect(blockKindsOf(RTR_HTML_V2)).toContain(k);
  });

  it('only hr gains an attribute in v2 (the page-break marker)', () => {
    expect(allowedAttributesOf(RTR_HTML_V1)).toEqual({ span: ['data-field'], div: ['data-asset'] });
    expect(allowedAttributesOf(RTR_HTML_V2)).toEqual({ span: ['data-field'], div: ['data-asset'], hr: ['data-break'] });
  });

  it('versions, downgrade and the Studio write version', () => {
    expect(isHtmlContentVersion(RTR_HTML_V1)).toBe(true);
    expect(isHtmlContentVersion(RTR_HTML_V2)).toBe(true);
    expect(isHtmlContentVersion('rtr-generated-v1')).toBe(false);
    expect(isContentDowngrade(RTR_HTML_V2, RTR_HTML_V1)).toBe(true);
    expect(isContentDowngrade(RTR_HTML_V1, RTR_HTML_V2)).toBe(false);
    expect(CURRENT_HTML_CONTENT_VERSION).toBe(RTR_HTML_V3);
  });

  it('limits per version', () => {
    expect(contentMaxBytesOf(RTR_HTML_V1)).toBe(CONTENT_MAX_BYTES_V1);
    expect(CONTENT_MAX_BYTES_V1).toBe(65536);
    expect(contentMaxBytesOf(RTR_HTML_V2)).toBe(CONTENT_MAX_BYTES_V2);
    expect(CONTENT_MAX_BYTES_V2).toBe(262144);
    expect(listMaxDepthOf(RTR_HTML_V2)).toBe(2);
    expect(listMaxDepthOf(RTR_HTML_V1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('heading levels', () => {
    expect([headingLevelOf('h2'), headingLevelOf('h3'), headingLevelOf('h4'), headingLevelOf('h5')]).toEqual([2, 3, 4, null]);
  });

  it('one placeholder pattern: spaces allowed inside the braces, keys kept in order', () => {
    expect(placeholderKeysIn('Hi {{ talent.full_name }}, from {{organization.name}} and {{talent.full_name}}.')).toEqual(['talent.full_name', 'organization.name', 'talent.full_name']);
    expect(placeholderKeysIn('{{ bad key }} {single}')).toEqual([]);
    // A fresh RegExp each call: no shared lastIndex between callers.
    expect(placeholderTokenRe()).not.toBe(placeholderTokenRe());
  });
});
