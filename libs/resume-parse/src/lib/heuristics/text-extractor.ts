import JSZip from 'jszip';
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
// no native deps, and produce plain text handed to the governed extractor
// (@aramo/talent-extraction). TI-1F P0.2 retired the heuristic field-extractor;
// governed LLM is the sole résumé fact extractor.
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
      const body = result.value;
      // mammoth reads word/document.xml ONLY — it drops HEADER/FOOTER parts.
      // Many résumés put the contact block (name, email, phone, City/ST ZIP) in
      // the Word header, so it would never reach extraction. Pull header/footer
      // text and PREPEND the header (so the contact block lands at the top for
      // the name heuristic + source-map block 0 + local email/phone extraction).
      const aux = await extractDocxHeaderFooterText(buffer);
      const text = aux !== '' ? `${aux}\n\n${body}` : body;
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }

  return null;
}

// Extract plain text from a DOCX's header/footer parts (word/header*.xml,
// word/footer*.xml) — which mammoth does not read. Headers first (the contact
// block), then footers; identical parts (a header repeated for first/odd/even
// pages) are de-duplicated. Best-effort: any failure yields '' (the body text
// still returns). Deterministic, no LLM.
async function extractDocxHeaderFooterText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter((n) =>
      /^word\/(header|footer)\d*\.xml$/.test(n),
    );
    const headers = names.filter((n) => n.includes('header')).sort();
    const footers = names.filter((n) => n.includes('footer')).sort();
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const name of [...headers, ...footers]) {
      const file = zip.file(name);
      if (file === null) continue;
      const xml = await file.async('string');
      const t = docxXmlRunsToText(xml);
      if (t !== '' && !seen.has(t)) {
        seen.add(t);
        parts.push(t);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

// Turn WordprocessingML runs into plain text: one line per paragraph (<w:p>),
// concatenating that paragraph's <w:t> run text. Tabs (<w:tab/>) → spaces so
// "Name<tab>City, ST" stays on one line. XML entities decoded.
function docxXmlRunsToText(xml: string): string {
  const lines: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const withTabs = para.replace(/<w:tab\b[^>]*\/>/g, ' ');
    const runs = [...withTabs.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) =>
      decodeXmlEntities(m[1] ?? ''),
    );
    const line = runs.join('').replace(/[ \t]+/g, ' ').trim();
    if (line !== '') lines.push(line);
  }
  return lines.join('\n');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
