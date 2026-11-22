// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit row 25: one file check for both clients (leading bytes, 25 MB PDF, Word only when allowed, 20 MB).
import { MAX_PDF_BYTES, MAX_WORD_BYTES, NOT_PDF_REFUSAL, TOO_LARGE_REFUSAL, WORD_COPY, checkPickedFile, convertibleWordName, looksLikePdf, titleFromFilename, wordUploadEnabled } from '../index.js';

const bytes = (s: string): Uint8Array => Uint8Array.from(s.split('').map((c) => c.charCodeAt(0)));
const PDF = bytes('%PDF-1.7\n');
const DOCX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const DOC = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const JUNK = bytes('hello world');

describe('file rules (row 25)', () => {
  it('limits', () => {
    expect(MAX_PDF_BYTES).toBe(26_214_400);
    expect(MAX_WORD_BYTES).toBe(20_971_520);
  });

  it.each([
    ['a PDF', { name: 'a.pdf', head: PDF, size: 10 }, { ok: true }],
    ['a PDF named .txt (bytes decide)', { name: 'a.txt', head: PDF, size: 10 }, { ok: true }],
    ['a .pdf that is not a PDF', { name: 'a.pdf', mimeType: 'application/pdf', head: JUNK }, { ok: false, reason: 'not_pdf', message: NOT_PDF_REFUSAL }],
    ['a PDF over 25 MB', { name: 'a.pdf', head: PDF, size: MAX_PDF_BYTES + 1 }, { ok: false, reason: 'too_large', message: TOO_LARGE_REFUSAL }],
    ['a PDF at 25 MB', { name: 'a.pdf', head: PDF, size: MAX_PDF_BYTES }, { ok: true }],
    ['Word when not allowed', { name: 'a.docx', head: DOCX }, { ok: false, reason: 'word', message: WORD_COPY.word_conversion_disabled }],
    ['Word bytes, any name, not allowed', { name: 'a.bin', head: DOC }, { ok: false, reason: 'word', message: WORD_COPY.word_conversion_disabled }],
    ['Word when allowed', { name: 'a.docx', head: DOCX, size: 10, wordAllowed: true }, { ok: true, word: true }],
    ['.doc when allowed', { name: 'a.doc', head: DOC, wordAllowed: true }, { ok: true, word: true }],
    ['Word over 20 MB', { name: 'a.docx', head: DOCX, size: MAX_WORD_BYTES + 1, wordAllowed: true }, { ok: false, reason: 'word_too_large', message: WORD_COPY.word_too_large }],
    ['a .docx that is not Word', { name: 'a.docx', head: JUNK, wordAllowed: true }, { ok: false, reason: 'word_unreadable', message: WORD_COPY.word_conversion_failed }],
    ['.dotx stays refused when allowed', { name: 'a.dotx', head: DOCX, wordAllowed: true }, { ok: false, reason: 'word', message: WORD_COPY.word_conversion_disabled }],
    ['a PDF named .docx is refused by its Word name', { name: 'a.docx', head: PDF, wordAllowed: true }, { ok: false, reason: 'word', message: WORD_COPY.word_conversion_disabled }],
  ])('%s', (_n, input, expected) => {
    expect(checkPickedFile(input)).toEqual(expected);
  });

  it.each([
    [PDF, true],
    [bytes(`${' '.repeat(1000)}%PDF-1.4`), true],
    [bytes(`${' '.repeat(1100)}%PDF-1.4`), false],
    [JUNK, false],
  ])('looksLikePdf %#', (head, ok) => {
    expect(looksLikePdf(head)).toBe(ok);
  });

  it.each([
    ['Offer.docx', null, 'Offer.docx'],
    ['Offer', 'application/msword', 'Offer.doc'],
    ['', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Document.docx'],
    ['Offer.rtf', null, null],
    ['Offer', 'text/plain', null],
  ])('convertibleWordName(%j, %j) → %j', (name, mime, out) => {
    expect(convertibleWordName(name, mime)).toBe(out);
  });

  it.each([
    ['Offer letter.pdf', 'Offer letter'],
    ['Offer.DOCX', 'Offer'],
    ['.pdf', 'Document'],
  ])('titleFromFilename %j', (name, title) => {
    expect(titleFromFilename(name)).toBe(title);
  });

  it.each([
    [{ word_conversion_enabled: true }, true],
    [{ word_conversion_enabled: 'true' }, false],
    [{}, false],
    [null, false],
  ])('wordUploadEnabled %j', (ctx, on) => {
    expect(wordUploadEnabled(ctx)).toBe(on);
  });
});
