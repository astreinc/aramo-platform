// Search PR-2 — résumé-text redaction (Lead Ruling R2 / ADR-0015 Addendum D4).
//
// Because content-search shows SNIPPETS (D2), an unredacted SSN-shaped string
// in a résumé could surface in a result. We redact SSN-shaped patterns at
// PERSIST time — so they are neither stored, nor indexed (the tsvector is
// GENERATED from redacted_text), nor shown in a ts_headline snippet — while
// keeping the rest of the body RAW (broad redaction would degrade recall, and
// nobody résumé-searches by SSN).
//
// Scope (Ruling R2 + the ratified addendum): SSN-shaped 3-2-4 groupings with
// the three common separators. The bare contiguous 9-digit form is
// DELIBERATELY excluded — it collides with other résumé numerics (IDs, phone
// runs, dates) and would hurt recall for no privacy gain a recruiter cares
// about. If the ratified addendum widens the set (DOB/phone), extend here.
//
// NOTE: this runs in the async re-extract path ONLY (the new post-attachment-
// commit seam). The E2 parse path (resume-parser.service.parseFromStorageKey)
// is UNCHANGED — it never persisted text and still does not.

const SSN_SHAPED_PATTERNS: readonly RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // 123-45-6789
  /\b\d{3} \d{2} \d{4}\b/g, // 123 45 6789
  /\b\d{3}\.\d{2}\.\d{4}\b/g, // 123.45.6789
];

export const REDACTION_PLACEHOLDER = '[REDACTED-SSN]';

/**
 * Redact SSN-shaped patterns from résumé body text. Returns the text with
 * every SSN-shaped match replaced by REDACTION_PLACEHOLDER; all other content
 * is preserved verbatim (recall-neutral). Pure + deterministic.
 */
export function redactResumeText(text: string): string {
  let out = text;
  for (const pattern of SSN_SHAPED_PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return out;
}
