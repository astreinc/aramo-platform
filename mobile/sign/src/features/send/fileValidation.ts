// Step 1 source checks (directive §5; M-A3 §8). PDF only by default: a Word file is
// refused with a clear message before any upload; the server refuses it too (400
// unsupported_file_type).
// M-A13 R-4 (#8): when the sender context advertises `word_conversion_enabled`, a .docx /
// .doc file is accepted as is and uploaded; the server converts it to PDF. Other Word-like
// formats (templates, macro files, RTF, ODT) keep today's refusal.
import { WORD_COPY } from '../../api/refusalMessages';
import { looksLikePdf } from '../editor/pdfPageSizes';

/** The server's upload cap (openapi/sign.yaml uploadSenderDocument: 25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const WORD_REFUSAL: string = WORD_COPY.word_conversion_disabled;
/** M-A13 R-4 — the server's Word input limit (20 MB). */
export const WORD_MAX_BYTES = 20 * 1024 * 1024;
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

/** The Word files the server converts (by file name, as the server decides). */
const CONVERTIBLE_EXT = /\.(docx|doc)$/i;
const CONVERTIBLE_MIME: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
};

/** M-A13 R-4 — the sender context's capability (absent = off). */
export function wordUploadEnabled(ctx: unknown): boolean {
  return (ctx as { word_conversion_enabled?: unknown } | null | undefined)?.word_conversion_enabled === true;
}

/**
 * The picker filter. Word types are listed on purpose so a Word file can be chosen and
 * then refused with an explanation, instead of silently not being selectable.
 */
export const PICKER_TYPES = ['application/pdf', ...WORD_MIME];

export type FileCheck =
  /** `word`: a .docx / .doc to upload as is (only when Word upload is enabled). */
  | { readonly ok: true; readonly word?: true }
  | {
      readonly ok: false;
      readonly reason: 'word' | 'not_pdf' | 'too_large' | 'word_too_large' | 'word_unreadable';
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
  /** M-A13 R-4 — the server converts .docx / .doc (sender context word_conversion_enabled). */
  readonly wordAllowed?: boolean;
}): FileCheck {
  const mime = (input.mimeType ?? '').toLowerCase();
  if (input.wordAllowed && convertibleWordName(input.name, mime) !== null && !looksLikePdf(input.head)) {
    if (!isWordBytes(input.head)) {
      return { ok: false, reason: 'word_unreadable', message: WORD_COPY.word_conversion_failed };
    }
    if (typeof input.size === 'number' && input.size > WORD_MAX_BYTES) {
      return { ok: false, reason: 'word_too_large', message: WORD_COPY.word_too_large };
    }
    return { ok: true, word: true };
  }
  if (WORD_EXT.test(input.name) || WORD_MIME.has(mime) || isWordBytes(input.head)) {
    return { ok: false, reason: 'word', message: WORD_REFUSAL };
  }
  if (!looksLikePdf(input.head)) return { ok: false, reason: 'not_pdf', message: NOT_PDF_REFUSAL };
  if (typeof input.size === 'number' && input.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'too_large', message: TOO_LARGE_REFUSAL };
  }
  return { ok: true };
}

/**
 * The upload name of a convertible Word file: its own name when it ends in .docx / .doc,
 * else the name plus the extension its MIME type implies; null when it is not one.
 */
export function convertibleWordName(name: string, mimeType?: string | null): string | null {
  if (CONVERTIBLE_EXT.test(name.trim())) return name.trim();
  if (WORD_EXT.test(name)) return null; // .dotx, .docm, .rtf, … keep the refusal
  const ext = CONVERTIBLE_MIME[(mimeType ?? '').toLowerCase()];
  return ext ? `${name.trim() || 'Document'}${ext}` : null;
}

/** A display title from a file name ("Offer letter.pdf" / "Offer letter.docx" -> "Offer letter"). */
export function titleFromFilename(name: string): string {
  const t = name.replace(/\.(pdf|docx|doc)$/i, '').trim();
  return (t.length > 0 ? t : 'Document').slice(0, 200);
}
