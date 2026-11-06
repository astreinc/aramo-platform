import {
  WORD_CONVERSION_TIMEOUT_MS,
  WORD_MAX_BYTES,
  WordConversionError,
  disabledWordConversion,
  type WordConversionPort,
} from './word-conversion.port.js';

// Aramo-Sign-Mobile-Amendment-M-A13 R-4 (#8) — the HTTP adapter of a pinned,
// LibreOffice-based converter that runs as its own service (Gotenberg-style API:
// POST multipart/form-data `files` to {base}/forms/libreoffice/convert, PDF back).
// The converter container is configured with no network egress and LibreOffice's default
// macro security (macros are never executed); adding it to a deployment is part of the
// deploy authorization, not this code.
//
// Error mapping (the upload answers with details.reason):
//   input over 20 MB                                -> word_too_large
//   an encrypted OOXML package (OLE "EncryptedPackage"),
//   or a converter refusal that names a password     -> word_password_protected
//   timeout (60 s), transport error, non-2xx, not a PDF -> word_conversion_failed

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// UTF-16LE stream names an encrypted Office document carries in its OLE directory.
const ENCRYPTED_MARKERS = ['EncryptedPackage', 'EncryptionInfo'].map((n) => Buffer.from(n, 'utf16le'));

/** An Office file protected by a password to open (OOXML in an OLE "EncryptedPackage"). */
export function isEncryptedOfficePackage(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length || OLE_MAGIC.some((b, i) => bytes[i] !== b)) return false;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return ENCRYPTED_MARKERS.some((m) => buf.includes(m));
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

export class LibreOfficeWordConverterAdapter implements WordConversionPort {
  readonly enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = WORD_CONVERSION_TIMEOUT_MS,
  ) {}

  async convert(input: { bytes: Uint8Array; filename: string }): Promise<Uint8Array> {
    if (input.bytes.byteLength > WORD_MAX_BYTES) throw new WordConversionError('word_too_large', 'This Word file is over 20 MB');
    if (isEncryptedOfficePackage(input.bytes)) throw new WordConversionError('word_password_protected', 'This Word file is password-protected');
    const name = input.filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'document.docx';
    const form = new FormData();
    form.append('files', new Blob([Buffer.from(input.bytes)]), name);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/forms/libreoffice/convert`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as { name?: string }).name === 'TimeoutError' || (e as { name?: string }).name === 'AbortError';
      throw new WordConversionError('word_conversion_failed', timedOut ? 'The Word conversion timed out' : 'The Word converter could not be reached');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (/password/i.test(text)) throw new WordConversionError('word_password_protected', 'This Word file is password-protected');
      if (res.status === 413) throw new WordConversionError('word_too_large', 'This Word file is over 20 MB');
      throw new WordConversionError('word_conversion_failed', `The Word converter refused the file (HTTP ${res.status})`);
    }
    const pdf = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(pdf)) throw new WordConversionError('word_conversion_failed', 'The Word converter did not return a PDF');
    return pdf;
  }
}

/**
 * R-4 — dark by default. Enabled only with SIGN_WORD_CONVERSION_ENABLED=1 and an http(s)
 * SIGN_WORD_CONVERTER_URL; otherwise the disabled port (Word uploads keep today's refusal).
 */
export function wordConverterFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): WordConversionPort {
  if (env['SIGN_WORD_CONVERSION_ENABLED'] !== '1') return disabledWordConversion;
  const url = (env['SIGN_WORD_CONVERTER_URL'] ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return disabledWordConversion;
  return new LibreOfficeWordConverterAdapter(url, fetchImpl);
}
