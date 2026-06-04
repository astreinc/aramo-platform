import mammoth from 'mammoth';
// @ts-expect-error -- pdf-parse ships CJS without TS types; the runtime
// surface is `(buffer) => Promise<{ text: string, ... }>`. We import the
// inner path (lib/pdf-parse.js) to skip the package's index.js, which
// runs a self-test that reads a sample PDF from disk -- the self-test
// throws ENOENT in production because the sample file is not packaged.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// A8-3b — deterministic text extraction (NO LLM per ADR-0015 Decision 10).
//
// Two formats: PDF (via pdf-parse) + DOCX (via mammoth). Both are pure-JS,
// no native deps, and produce plain text we feed to the field-extractor.
//
// Format detection: magic-byte sniff on the buffer head. PDFs start with
// `%PDF-`; DOCX files are ZIPs and start with `PK\x03\x04`. Anything else
// returns null (the caller surfaces parse_status='failed').

export type ResumeFormat = 'pdf' | 'docx' | 'unknown';

export function detectResumeFormat(buffer: Buffer): ResumeFormat {
  if (buffer.length < 4) return 'unknown';

  // PDF magic: 25 50 44 46 ("%PDF").
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return 'pdf';
  }

  // ZIP magic: 50 4B 03 04 (DOCX, XLSX, etc. — DOCX is the ZIP we accept).
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return 'docx';
  }

  return 'unknown';
}

/**
 * Extract plain text from a résumé buffer. Returns null on any failure
 * (corrupt file, encrypted PDF, unsupported format, library throw).
 * The caller maps null → parse_status='failed'.
 */
export async function extractResumeText(buffer: Buffer): Promise<string | null> {
  const format = detectResumeFormat(buffer);

  if (format === 'pdf') {
    try {
      const result = (await pdfParse(buffer)) as { text?: string };
      const text = result.text ?? '';
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }

  if (format === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value;
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }

  return null;
}
