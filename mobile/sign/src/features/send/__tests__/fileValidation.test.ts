import {
  NOT_PDF_REFUSAL,
  PICKER_TYPES,
  TOO_LARGE_REFUSAL,
  WORD_REFUSAL,
  checkPickedFile,
} from '../fileValidation';

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
