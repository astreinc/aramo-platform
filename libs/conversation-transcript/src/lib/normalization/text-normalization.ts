// CI-B4 — deterministic STRUCTURAL text cleanup only (directive §text-
// preservation). This performs the minimal, reversible-in-spirit normalization
// needed to produce a canonical representation. It NEVER performs semantic
// transformation: no grammar/spelling correction, no paraphrase, no summary, no
// hedging removal, no dedup, no "improvement". The canonical text remains
// evidentiary transcript wording.

/**
 * Structural cleanup:
 *   * Unicode NFC (deterministic canonical composition — same grapheme, one
 *     byte form);
 *   * CRLF / lone CR normalized to LF;
 *   * trailing/leading WHOLE-STRING whitespace trimmed.
 * Internal spacing/newlines and every semantic character are preserved.
 */
export function normalizeUtteranceText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s+|\s+$/g, '');
}
