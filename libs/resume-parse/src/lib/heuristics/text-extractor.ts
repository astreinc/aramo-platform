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
// governed LLM is the sole resume fact extractor.
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
 * Extract plain text from a resume buffer. Returns null on any failure
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
      const result = await mammoth.extractRawText({ buffer: await withBodyLineBreaksAsText(buffer) });
      const body = result.value;
      // mammoth reads word/document.xml ONLY — it drops HEADER/FOOTER parts.
      // Many resumes put the contact block (name, email, phone, City/ST ZIP) in
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

// mammoth's raw-text output drops line breaks (<w:br/>, <w:cr/>) inside a
// paragraph, so "555-201-3344<br/>jane@example.com" reaches extraction glued as
// one token (the email redaction then swallows the phone). Rewrite each break in
// word/document.xml as a newline text node in the same run before mammoth reads
// it. A document with no breaks is passed through unchanged; any failure falls
// back to the original bytes.
async function withBodyLineBreaksAsText(buffer: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file('word/document.xml');
    if (file === null) return buffer;
    const xml = await file.async('string');
    if (!/<w:(?:br|cr)\b/.test(xml)) return buffer;
    zip.file('word/document.xml', xml.replace(LINE_BREAK_RE, '<w:t xml:space="preserve">&#10;</w:t>'));
    return await zip.generateAsync({ type: 'nodebuffer' });
  } catch {
    return buffer;
  }
}

// A paragraph's text-bearing tokens, in document order: run text, tabs, and
// line breaks. <w:tab/> inside paragraph properties (<w:tabs> tab-stop
// definitions) is excluded by stripping <w:pPr> first.
const PARAGRAPH_PROPERTIES_RE = /<w:pPr\b[\s\S]*?<\/w:pPr>/g;
const RUN_TOKEN_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
const LINE_BREAK_RE = /<w:(?:br|cr)\b[^>]*\/>/g;

// Turn WordprocessingML runs into plain text: one line per paragraph (<w:p>),
// concatenating that paragraph's <w:t> run text in order. Tabs (<w:tab/>) →
// spaces so "Name<tab>City, ST" stays on one line; line breaks (<w:br/>,
// <w:cr/>) start a new line. Without these separators a "phone<tab>email" or
// "phone<br/>email" header came out glued. XML entities decoded.
function docxXmlRunsToText(xml: string): string {
  const lines: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    let text = '';
    for (const m of para.replace(PARAGRAPH_PROPERTIES_RE, '').matchAll(RUN_TOKEN_RE)) {
      const token = m[0];
      if (token.startsWith('<w:tab')) text += ' ';
      else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) text += '\n';
      else text += decodeXmlEntities(m[1] ?? '');
    }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/[ \t]+/g, ' ').trim();
      if (line !== '') lines.push(line);
    }
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
