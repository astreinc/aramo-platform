// Aramo-Sign-Mobile-Amendment-M-A13-Field-Test-Remediation-v1_0-LOCKED R-4 (#8) — Word to
// PDF conversion for the sender document upload. The PDF becomes the document source (the
// original Word file is never stored). Dark by default: SIGN_WORD_CONVERSION_ENABLED=1 and
// a converter URL (SIGN_WORD_CONVERTER_URL) are both required.

export const WORD_CONVERSION_PORT = 'WORD_CONVERSION_PORT';

/** R-4 — the input limit (20 MB) and the conversion timeout (60 s). */
export const WORD_MAX_BYTES = 20 * 1024 * 1024;
export const WORD_CONVERSION_TIMEOUT_MS = 60_000;

export type WordConversionRefusal = 'word_too_large' | 'word_password_protected' | 'word_conversion_failed';

export class WordConversionError extends Error {
  constructor(public readonly reason: WordConversionRefusal, message: string) {
    super(message);
    this.name = 'WordConversionError';
  }
}

export interface WordConversionPort {
  /** True only when the flag is on AND a converter is configured. */
  readonly enabled: boolean;
  /** Word bytes -> PDF bytes. Throws WordConversionError. */
  convert(input: { bytes: Uint8Array; filename: string }): Promise<Uint8Array>;
}

/** The file names the upload treats as Word (.docx, .doc). */
export function isWordFilename(filename: string): boolean {
  return /\.(docx|doc)$/i.test(filename.trim());
}

export const disabledWordConversion: WordConversionPort = {
  enabled: false,
  convert: () => Promise.reject(new WordConversionError('word_conversion_failed', 'Word conversion is not enabled')),
};
