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
    // JPEG magic (FF D8) — not a résumé format we accept.
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectResumeFormat(buf)).toBe('unknown');
  });
});

describe('A8-3b — extractResumeText failure modes', () => {
  it('returns null for unknown format (plain text input)', async () => {
    const buf = Buffer.from('Just a text file, not a résumé', 'utf8');
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
