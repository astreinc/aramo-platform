import {
  NOT_PDF_REFUSAL,
  PICKER_TYPES,
  TOO_LARGE_REFUSAL,
  WORD_MAX_BYTES,
  WORD_REFUSAL,
  checkPickedFile,
  convertibleWordName,
  titleFromFilename,
  wordUploadEnabled,
} from '../fileValidation';
import { refusalMessage } from '../../../api/refusalMessages';

const PDF_HEAD = new Uint8Array(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1'));
const DOCX_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const DOC_HEAD = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

describe('PDF only (directive §5, M-A3 §8)', () => {
  it('accepts a PDF', () => {
    expect(
      checkPickedFile({
        name: 'Offer.pdf',
        mimeType: 'application/pdf',
        size: 1000,
        head: PDF_HEAD,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['by extension', { name: 'Offer.docx', mimeType: 'application/octet-stream', head: PDF_HEAD }],
    ['by MIME type', { name: 'Offer', mimeType: 'application/msword', head: PDF_HEAD }],
    ['a .docx by its bytes', { name: 'Offer', mimeType: null, head: DOCX_HEAD }],
    ['a .doc by its bytes', { name: 'Offer', mimeType: null, head: DOC_HEAD }],
    ['an RTF', { name: 'Offer.rtf', mimeType: 'text/rtf', head: PDF_HEAD }],
  ])('refuses a Word file %s with a clear message', (_label, input) => {
    expect(checkPickedFile(input)).toEqual({ ok: false, reason: 'word', message: WORD_REFUSAL });
  });

  it('says Word files must be saved as PDF (no conversion)', () => {
    expect(WORD_REFUSAL).toMatch(/Word/);
    expect(WORD_REFUSAL).toMatch(/PDF/);
  });

  it('refuses other files and oversized PDFs', () => {
    expect(
      checkPickedFile({
        name: 'photo.png',
        mimeType: 'image/png',
        head: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      }),
    ).toEqual({
      ok: false,
      reason: 'not_pdf',
      message: NOT_PDF_REFUSAL,
    });
    expect(checkPickedFile({ name: 'big.pdf', size: 26 * 1024 * 1024, head: PDF_HEAD })).toEqual({
      ok: false,
      reason: 'too_large',
      message: TOO_LARGE_REFUSAL,
    });
  });

  it('lists Word types in the picker only so they can be refused with the message', () => {
    expect(PICKER_TYPES[0]).toBe('application/pdf');
    expect(PICKER_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

describe('Word upload when the server converts (M-A13 R-4)', () => {
  it('reads the capability from the sender context (absent = off)', () => {
    expect(wordUploadEnabled({ word_conversion_enabled: true })).toBe(true);
    expect(wordUploadEnabled({ word_conversion_enabled: false })).toBe(false);
    expect(wordUploadEnabled({})).toBe(false);
    expect(wordUploadEnabled(undefined)).toBe(false);
  });

  it('flag off: a Word file keeps today\'s message', () => {
    expect(checkPickedFile({ name: 'Offer.docx', head: DOCX_HEAD })).toEqual({
      ok: false,
      reason: 'word',
      message: WORD_REFUSAL,
    });
    expect(checkPickedFile({ name: 'Offer.docx', head: DOCX_HEAD, wordAllowed: false }).ok).toBe(false);
  });

  it('flag on: .docx and .doc are accepted as Word', () => {
    expect(checkPickedFile({ name: 'Offer.docx', head: DOCX_HEAD, wordAllowed: true })).toEqual({ ok: true, word: true });
    expect(checkPickedFile({ name: 'Offer.DOC', head: DOC_HEAD, wordAllowed: true })).toEqual({ ok: true, word: true });
    // Named only by its MIME type (a cloud provider without an extension).
    expect(
      checkPickedFile({
        name: 'Offer',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        head: DOCX_HEAD,
        wordAllowed: true,
      }),
    ).toEqual({ ok: true, word: true });
    expect(convertibleWordName('Offer', 'application/msword')).toBe('Offer.doc');
    // A PDF stays a PDF.
    expect(checkPickedFile({ name: 'a.pdf', head: PDF_HEAD, wordAllowed: true })).toEqual({ ok: true });
  });

  it('flag on: other Word-like formats keep the refusal', () => {
    for (const name of ['a.dotx', 'a.docm', 'a.rtf', 'a.odt']) {
      expect(checkPickedFile({ name, head: DOCX_HEAD, wordAllowed: true })).toEqual({
        ok: false,
        reason: 'word',
        message: WORD_REFUSAL,
      });
    }
  });

  it('flag on: over 20 MB, or not really a Word file, is refused with the plain message', () => {
    expect(
      checkPickedFile({ name: 'big.docx', size: WORD_MAX_BYTES + 1, head: DOCX_HEAD, wordAllowed: true }),
    ).toEqual({ ok: false, reason: 'word_too_large', message: 'This Word file is over 20 MB.' });
    expect(
      checkPickedFile({ name: 'x.docx', head: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), wordAllowed: true }),
    ).toEqual({
      ok: false,
      reason: 'word_unreadable',
      message: 'We couldn’t convert this Word file. Save it as a PDF, then choose the PDF.',
    });
  });

  it('titles drop the Word extension', () => {
    expect(titleFromFilename('Offer letter.docx')).toBe('Offer letter');
    expect(titleFromFilename('Offer letter.doc')).toBe('Offer letter');
  });

  it('server refusals map to the plain messages', () => {
    const msg = (reason: string) => refusalMessage({ reason, code: 'VALIDATION_ERROR' });
    expect(msg('word_too_large')).toBe('This Word file is over 20 MB.');
    expect(msg('word_password_protected')).toBe(
      'This Word file is password-protected. Remove the password, then try again.',
    );
    expect(msg('word_conversion_failed')).toBe(
      'We couldn’t convert this Word file. Save it as a PDF, then choose the PDF.',
    );
    expect(msg('word_conversion_disabled')).toBe(WORD_REFUSAL);
  });
});
