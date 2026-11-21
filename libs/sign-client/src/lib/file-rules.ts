// Client Rule Consolidation C3 (audit row 25) — the sender document checks, in ONE function
// both Sign clients call before an upload: the file's leading bytes decide (never only the
// name or MIME type), a PDF is at most 25 MB, and a Word file (.docx / .doc) is accepted
// ONLY when the sender context says the server converts Word (word_conversion_enabled) and
// the client supports it; it is then at most 20 MB. The server checks everything again
// (esign-object-storage-document.adapter.ts, word-conversion.port.ts use these limits).

/** The server's cap on a source PDF (25 MiB). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** M-A13 R-4 — the server's Word input limit (20 MiB). */
export const MAX_WORD_BYTES = 20 * 1024 * 1024;

/** M-A13 R-4 — the Word refusals (also server reasons; the copy lives in refusal-messages). */
export const WORD_COPY = {
  word_too_large: 'This Word file is over 20 MB.',
  word_password_protected: 'This Word file is password-protected. Remove the password, then try again.',
  word_conversion_failed: 'We couldn’t convert this Word file. Save it as a PDF, then choose the PDF.',
  word_conversion_disabled: 'Word files can’t be sent. Save the document as a PDF, then choose the PDF.',
} as const;

export const NOT_PDF_REFUSAL = 'Only PDF files can be sent for signature.';
export const TOO_LARGE_REFUSAL = 'This PDF is larger than 25 MB. Choose a smaller file.';

const WORD_EXT = /\.(docx?|docm|dotx?|dotm|rtf|odt)$/i;
const WORD_MIME = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/rtf',
  'text/rtf',
  'application/vnd.oasis.opendocument.text',
] as const;
const WORD_MIME_SET: ReadonlySet<string> = new Set(WORD_MIME);

const CONVERTIBLE_EXT = /\.(docx|doc)$/i;
const CONVERTIBLE_MIME: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
};

/** The picker filter: PDF, plus the Word types (so a Word file can be chosen and then explained). */
export const PDF_PICKER_TYPES: readonly string[] = ['application/pdf'];
export const PICKER_TYPES: readonly string[] = [...PDF_PICKER_TYPES, ...WORD_MIME];

/** The sender context's Word capability (absent = off). */
export function wordUploadEnabled(ctx: unknown): boolean {
  return (ctx as { word_conversion_enabled?: unknown } | null | undefined)?.word_conversion_enabled === true;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i] ?? 0);
  return s;
}

/** A PDF header within the first 1024 bytes (the PDF spec allows leading junk). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(0, Math.min(bytes.length, 1024))).includes('%PDF-');
}

function isWordBytes(head: Uint8Array): boolean {
  // OLE2 compound file (legacy .doc), a ZIP container (.docx) or an RTF header.
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (ole.every((b, i) => head[i] === b)) return true;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return true;
  return head[0] === 0x7b && head[1] === 0x5c && head[2] === 0x72 && head[3] === 0x74; // {\rt
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

export type FileCheck =
  /** `word`: a .docx / .doc to upload as is (only when Word upload is allowed). */
  | { readonly ok: true; readonly word?: true }
  | {
      readonly ok: false;
      readonly reason: 'word' | 'not_pdf' | 'too_large' | 'word_too_large' | 'word_unreadable';
      readonly message: string;
    };

/** Classify a picked file by its name, MIME type, size and leading bytes. */
export function checkPickedFile(input: {
  readonly name: string;
  readonly mimeType?: string | null | undefined;
  readonly size?: number | null | undefined;
  /** The first bytes of the file (at least 8; 1024 is plenty). */
  readonly head: Uint8Array;
  /** The server converts .docx / .doc (sender context word_conversion_enabled) and the client uploads Word. */
  readonly wordAllowed?: boolean;
}): FileCheck {
  const mime = (input.mimeType ?? '').toLowerCase();
  if (input.wordAllowed === true && convertibleWordName(input.name, mime) !== null && !looksLikePdf(input.head)) {
    if (!isWordBytes(input.head)) return { ok: false, reason: 'word_unreadable', message: WORD_COPY.word_conversion_failed };
    if (typeof input.size === 'number' && input.size > MAX_WORD_BYTES) return { ok: false, reason: 'word_too_large', message: WORD_COPY.word_too_large };
    return { ok: true, word: true };
  }
  if (WORD_EXT.test(input.name) || WORD_MIME_SET.has(mime) || isWordBytes(input.head)) {
    return { ok: false, reason: 'word', message: WORD_COPY.word_conversion_disabled };
  }
  if (!looksLikePdf(input.head)) return { ok: false, reason: 'not_pdf', message: NOT_PDF_REFUSAL };
  if (typeof input.size === 'number' && input.size > MAX_PDF_BYTES) return { ok: false, reason: 'too_large', message: TOO_LARGE_REFUSAL };
  return { ok: true };
}

/** A display title from a file name ("Offer letter.pdf" / "Offer letter.docx" -> "Offer letter"). */
export function titleFromFilename(name: string): string {
  const t = name.replace(/\.(pdf|docx|doc)$/i, '').trim();
  return (t.length > 0 ? t : 'Document').slice(0, 200);
}
