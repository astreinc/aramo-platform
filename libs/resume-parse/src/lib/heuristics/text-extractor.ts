import { createAramoLogger } from '@aramo/common';
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

// RESUME-A1 v1.1 R3.2 / D-5 — identifies the text-extractor implementation that
// produced an extraction (persisted as ResumeExtractionDraft.extractor_version).
// NULL on earlier rows = pre-A1. Independent of RESUME_SOURCE_MAP_VERSION: the
// source-map schema + algorithm are unchanged (A2 accepted).
export const RESUME_TEXT_EXTRACTOR_VERSION = 'resume-text-extractor/2';

// RESUME-A1 v1.1 R1.2 / D-1 — a same-baseline gap of at least this many ems
// (gap ÷ font size) is a word separator. A BOUNDED heuristic supported by the
// A1 fixture corpus (R1.3), not a universal constant: below it sit hyphen joins
// and letter-spaced headings, which must stay intact.
export const PDF_SAME_BASELINE_SEPARATOR_EM = 0.25;

const logger = createAramoLogger('ResumeTextExtractor');

// The subset of the pdf.js v1.10 text-content item the renderer reads.
export interface PdfTextItem {
  readonly str: string;
  /** [a, b, c, d, e, f]: e/f = x/y origin; hypot(a, b) = font size. */
  readonly transform: readonly number[];
  readonly width: number;
}

/**
 * RESUME-A1 v1.1 R1 — render one page's text items exactly as pdf-parse's
 * default render_page does (node_modules/pdf-parse/lib/pdf-parse.js:15-35:
 * same `transform[5]` → same line, otherwise '\n'; including its `!lastY`
 * quirk), with ONE change: on a same-baseline join, insert a single space
 * when the visual gap is a word separator (R1.2). The default renderer
 * concatenates such items with no separator (`TOOLSJira`, `ENGINEERMar 2008`).
 */
export function renderPdfPageItems(items: readonly PdfTextItem[]): string {
  let text = '';
  let lastY: number | undefined;
  let lastEndX = 0;
  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    if (lastY === y || !lastY) {
      if (lastY === y && isWordGap(text, item, x - lastEndX)) text += ' ';
      text += item.str;
    } else {
      text += '\n' + item.str;
    }
    lastY = y;
    lastEndX = x + item.width;
  }
  return text;
}

function isWordGap(textSoFar: string, item: PdfTextItem, gap: number): boolean {
  if (textSoFar === '' || /\s$/.test(textSoFar) || /^\s/.test(item.str)) return false;
  const fontSize = Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0);
  if (!Number.isFinite(fontSize) || fontSize <= 0) return false;
  return gap >= PDF_SAME_BASELINE_SEPARATOR_EM * fontSize;
}

export type PdfIncompleteReason = 'page_not_rendered' | 'page_render_failed' | 'page_no_text';

export interface PdfPageRecord {
  /** pagerender resolved with text. */
  resolved: boolean;
  nonWhitespaceChars: number;
}

/**
 * RESUME-A1 v1.1 R2.2 — page accounting against the parser-DECLARED page count
 * (never pdf-parse's `numrender`, which is only its loop counter). Returns the
 * first incompleteness found, or null when every page 1..pageCount was reached,
 * resolved, and produced text. An empty-text page means the read cannot be
 * certified complete (blank / image-only pages included) — NOT that the file
 * is corrupt (R2.3).
 */
export function assessPdfCompleteness(
  pageCount: number,
  pages: ReadonlyMap<number, PdfPageRecord>,
): { reason: PdfIncompleteReason; page_index: number } | null {
  for (let page = 1; page <= pageCount; page++) {
    const record = pages.get(page);
    if (record === undefined) return { reason: 'page_not_rendered', page_index: page };
    if (!record.resolved) return { reason: 'page_render_failed', page_index: page };
    if (record.nonWhitespaceChars === 0) return { reason: 'page_no_text', page_index: page };
  }
  return null;
}

interface PdfPageProxy {
  readonly pageIndex: number;
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

/** Test seam (NOT exported from the lib index): runs before page `n` renders. */
export interface PdfExtractTestHooks {
  readonly beforePageRender?: (pageNumber: number) => void;
}

/**
 * RESUME-A1 v1.1 — PDF text via the existing pdf-parse integration with an
 * Aramo page renderer. pdf-parse swallows every page failure into '' and still
 * resolves (pdf-parse.js:86-88), and pdf.js returns zero text for pages whose
 * content/resources cannot be resolved without throwing; both used to surface
 * as a SUCCESSFUL partial read. Any incomplete page now fails the whole
 * extraction (null — the existing caller contract, D-3), with one structured
 * diagnostic carrying no document content.
 */
export async function extractPdfText(
  buffer: Buffer,
  hooks: PdfExtractTestHooks = {},
): Promise<string | null> {
  const pages = new Map<number, PdfPageRecord>();
  const pagerender = (page: PdfPageProxy): Promise<string> => {
    const pageNumber = page.pageIndex + 1;
    const record: PdfPageRecord = { resolved: false, nonWhitespaceChars: 0 };
    pages.set(pageNumber, record);
    return Promise.resolve()
      .then(() => {
        hooks.beforePageRender?.(pageNumber);
        return page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      })
      .then((content) => {
        const text = renderPdfPageItems(content.items);
        record.resolved = true;
        record.nonWhitespaceChars = text.replace(/\s/g, '').length;
        return text;
      });
  };

  let result: { text?: string; numpages?: number };
  try {
    result = (await pdfParse(buffer, { pagerender })) as { text?: string; numpages?: number };
  } catch {
    return null;
  }

  const pageCount = result.numpages ?? 0;
  const incomplete = assessPdfCompleteness(pageCount, pages);
  if (incomplete !== null) {
    logger.warn({
      event: 'resume_text.pdf_incomplete',
      reason: incomplete.reason,
      page_index: incomplete.page_index,
      page_count: pageCount,
    });
    return null;
  }
  const text = result.text ?? '';
  return text.length === 0 ? null : text;
}

/**
 * Extract plain text from a resume buffer. Returns null on any failure
 * (corrupt file, encrypted PDF, unsupported format, library throw, or — PDF —
 * any page that could not be read completely, RESUME-A1 R2).
 * The caller maps null → parse_status='failed'.
 */
export async function extractResumeText(buffer: Buffer): Promise<string | null> {
  const format = detectResumeFormat(buffer);

  if (format === 'pdf') {
    return extractPdfText(buffer);
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
