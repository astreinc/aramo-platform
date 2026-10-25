// Step 1 source checks (directive §5; M-A3 §8). PDF only: there is no Word
// conversion in this release, so a Word file is refused with a clear message before
// any upload. The server refuses it too (400 unsupported_file_type).
import { looksLikePdf } from '../editor/pdfPageSizes';

/** The server's upload cap (openapi/sign.yaml uploadSenderDocument: 25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const WORD_REFUSAL =
  'Word files can’t be sent. Save the document as a PDF, then choose the PDF.';
export const NOT_PDF_REFUSAL = 'Only PDF files can be sent for signature.';
export const TOO_LARGE_REFUSAL = 'This PDF is larger than 25 MB. Choose a smaller file.';

const WORD_EXT = /\.(docx?|docm|dotx?|dotm|rtf|odt)$/i;
const WORD_MIME = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/rtf',
  'text/rtf',
  'application/vnd.oasis.opendocument.text',
]);

/**
 * The picker filter. Word types are listed on purpose so a Word file can be chosen and
 * then refused with an explanation, instead of silently not being selectable.
 */
export const PICKER_TYPES = ['application/pdf', ...WORD_MIME];

export type FileCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'word' | 'not_pdf' | 'too_large';
      readonly message: string;
    };

function isWordBytes(head: Uint8Array): boolean {
  // OLE2 compound file (legacy .doc) or a ZIP container (.docx) / RTF header.
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (ole.every((b, i) => head[i] === b)) return true;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return true;
  return head[0] === 0x7b && head[1] === 0x5c && head[2] === 0x72 && head[3] === 0x74; // {\rt
}

/** Classify a picked file by name, MIME type and leading bytes. */
export function checkPickedFile(input: {
  readonly name: string;
  readonly mimeType?: string | null | undefined;
  readonly size?: number | null | undefined;
  /** The first bytes of the file (at least 8; 1024 is plenty). */
  readonly head: Uint8Array;
}): FileCheck {
  const mime = (input.mimeType ?? '').toLowerCase();
  if (WORD_EXT.test(input.name) || WORD_MIME.has(mime) || isWordBytes(input.head)) {
    return { ok: false, reason: 'word', message: WORD_REFUSAL };
  }
  if (!looksLikePdf(input.head)) return { ok: false, reason: 'not_pdf', message: NOT_PDF_REFUSAL };
  if (typeof input.size === 'number' && input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'too_large', message: TOO_LARGE_REFUSAL };
  }
  return { ok: true };
}

/** A display title from a file name ("Offer letter.pdf" -> "Offer letter"). */
export function titleFromFilename(name: string): string {
  const t = name.replace(/\.pdf$/i, '').trim();
  return (t.length > 0 ? t : 'Document').slice(0, 200);
}
