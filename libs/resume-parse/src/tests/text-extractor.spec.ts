import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { detectResumeFormat, extractResumeText } from '../lib/heuristics/text-extractor.js';

// A8-3b — text-extractor unit tests.
//
// Tests the magic-byte format detection + the failure-mode contract:
// extractResumeText returns null on any failure (unsupported format,
// corrupt bytes, library throw). The service maps null →
// parse_status='failed' (proof §4.4 -- parse-failure-non-blocking).

describe('A8-3b — detectResumeFormat', () => {
  it('detects PDF via %PDF magic', () => {
    const buf = Buffer.from('%PDF-1.4\n', 'utf8');
    expect(detectResumeFormat(buf)).toBe('pdf');
  });

  it('detects DOCX via PK\\x03\\x04 ZIP magic', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]);
    expect(detectResumeFormat(buf)).toBe('docx');
  });

  it('returns unknown for plain text', () => {
    const buf = Buffer.from('Hello world this is plain text', 'utf8');
    expect(detectResumeFormat(buf)).toBe('unknown');
  });

  it('returns unknown for tiny buffer', () => {
    expect(detectResumeFormat(Buffer.from([]))).toBe('unknown');
    expect(detectResumeFormat(Buffer.from([0x25, 0x50]))).toBe('unknown');
  });

  it('returns unknown for arbitrary binary that is not PDF/DOCX', () => {
    // JPEG magic (FF D8) — not a resume format we accept.
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectResumeFormat(buf)).toBe('unknown');
  });
});

describe('A8-3b — extractResumeText failure modes', () => {
  it('returns null for unknown format (plain text input)', async () => {
    const buf = Buffer.from('Just a text file, not a resume', 'utf8');
    const text = await extractResumeText(buf);
    expect(text).toBeNull();
  });

  it('returns null for empty buffer', async () => {
    const text = await extractResumeText(Buffer.from([]));
    expect(text).toBeNull();
  });

  it('returns null for corrupt PDF (magic but garbage body)', async () => {
    // %PDF header but no valid PDF structure -- pdf-parse throws,
    // we catch and return null.
    const buf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'utf8'),
      Buffer.from('garbage that does not parse as PDF', 'utf8'),
    ]);
    const text = await extractResumeText(buf);
    expect(text).toBeNull();
  });

  it('returns null for corrupt DOCX (ZIP magic but garbage body)', async () => {
    const buf = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('garbage that does not parse as a DOCX archive', 'utf8'),
    ]);
    const text = await extractResumeText(buf);
    expect(text).toBeNull();
  });
});

// E2E defect: a contact block laid out as "phone<tab>email" or "phone<br/>email"
// came out glued ("555-201-3344jane@example.com"), so the redaction captured one
// bogus email and no phone. Minimal synthetic DOCX packages, fake contact data.
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const ROOT_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

async function makeDocx(body: string, header?: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`);
  if (header !== undefined) zip.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W_NS}>${header}</w:hdr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const PHONE = '555-201-3344';
const EMAIL = 'jane-doe@example.com';
const BODY = '<w:p><w:r><w:t>Experience</w:t></w:r></w:p>';

describe('E2E — DOCX keeps contact separators', () => {
  it('header: a tab between phone and email becomes a space', async () => {
    const header = `<w:p><w:r><w:t>${PHONE}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${EMAIL}</w:t></w:r></w:p>`;
    const text = await extractResumeText(await makeDocx(BODY, header));
    expect(text?.split('\n')[0]).toBe(`${PHONE} ${EMAIL}`);
  });

  it('header: a line break between phone and email starts a new line', async () => {
    const header = `<w:p><w:r><w:t>${PHONE}</w:t><w:br/><w:t>${EMAIL}</w:t></w:r></w:p>`;
    const text = await extractResumeText(await makeDocx(BODY, header));
    expect(text?.split('\n').slice(0, 2)).toEqual([PHONE, EMAIL]);
  });

  it('header: tab-stop definitions in paragraph properties add no text', async () => {
    const header =
      '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs></w:pPr>' +
      '<w:r><w:t>Jane Doe</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Austin, TX</w:t></w:r></w:p>';
    const text = await extractResumeText(await makeDocx(BODY, header));
    expect(text?.split('\n')[0]).toBe('Jane Doe Austin, TX');
  });

  it('body: a line break inside a paragraph becomes a newline', async () => {
    const body = `<w:p><w:r><w:t>${PHONE}</w:t><w:br/><w:t>${EMAIL}</w:t></w:r></w:p>`;
    const text = await extractResumeText(await makeDocx(body));
    expect(text).toContain(`${PHONE}\n${EMAIL}`);
    expect(text).not.toContain(`${PHONE}${EMAIL}`);
  });

  it('body: a document without line breaks extracts as before', async () => {
    const body = `<w:p><w:r><w:t>${PHONE}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${EMAIL}</w:t></w:r></w:p>`;
    const text = await extractResumeText(await makeDocx(body));
    expect(text?.trim()).toBe(`${PHONE}\t${EMAIL}`);
  });
});
