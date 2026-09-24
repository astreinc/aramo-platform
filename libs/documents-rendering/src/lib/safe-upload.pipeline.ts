import { Injectable } from '@nestjs/common';

import { UnsafePdfError } from './errors.js';

// DOC-2 boundary 6 — the governed safe-upload pipeline (R27). SEPARATE from the
// renderer: pdf-lib opening a file does NOT mean the file is safe. Enforceable
// DOC-2 gates: size/type, encrypted/password (hard reject — never
// ignoreEncryption), structural validity, and active-content policy. Malware/AV
// scanning is a DEFERRED R27-track increment (no AV wired today) — not claimed here.

export interface SafePdfLimits {
  maxBytes: number;
  maxPages: number;
}

const DEFAULT_LIMITS: SafePdfLimits = {
  maxBytes: 25 * 1024 * 1024, // 25 MiB
  maxPages: 200,
};

// Dangerous active-content tokens. Presence => reject (DOC-2 policy is reject,
// not strip, to keep signable source evidence faithful to what was accepted).
const ACTIVE_CONTENT_TOKENS = ['/JavaScript', '/JS', '/Launch', '/OpenAction', '/AA', '/EmbeddedFile', '/RichMedia'];

@Injectable()
export class SafePdfPipeline {
  // Plain field (NOT a constructor-injected dependency): SafePdfLimits is a
  // config interface with no provider, so injecting it would break Nest DI at
  // AppModule boot. The limits are constants for DOC-2.
  private readonly limits: SafePdfLimits = DEFAULT_LIMITS;

  // Returns the accepted source bytes (unchanged) or throws UnsafePdfError. The
  // caller persists the returned bytes as the immutable SOURCE_UPLOAD artifact.
  async accept(bytes: Uint8Array): Promise<Uint8Array> {
    // 1. Size gate.
    if (bytes.byteLength === 0) throw new UnsafePdfError('empty file');
    if (bytes.byteLength > this.limits.maxBytes) {
      throw new UnsafePdfError(`exceeds max size (${bytes.byteLength} > ${this.limits.maxBytes})`);
    }
    // 2. Type gate — PDF magic bytes "%PDF-".
    const head = Buffer.from(bytes.slice(0, 5)).toString('latin1');
    if (head !== '%PDF-') throw new UnsafePdfError('not a PDF (missing %PDF- header)');

    const raw = Buffer.from(bytes).toString('latin1');

    // 3. Encrypted/password detection — hard reject. NEVER ignoreEncryption.
    if (/\/Encrypt\b/.test(raw)) throw new UnsafePdfError('encrypted/password-protected PDF');

    // 4. Active-content policy.
    for (const token of ACTIVE_CONTENT_TOKENS) {
      if (raw.includes(token)) throw new UnsafePdfError(`active content not allowed: ${token}`);
    }

    // 5. Structural validity + page/decompression-bomb bound — load with pdf-lib
    // (WITHOUT ignoreEncryption, so an encrypted doc that slipped the byte scan
    // still throws). Import is dynamic to keep pdf-lib strictly adapter-internal.
    const { PDFDocument } = await import('pdf-lib');
    let doc: import('pdf-lib').PDFDocument;
    try {
      doc = await PDFDocument.load(bytes);
    } catch (e) {
      throw new UnsafePdfError(`malformed or encrypted PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
    const pages = doc.getPageCount();
    if (pages > this.limits.maxPages) {
      throw new UnsafePdfError(`too many pages (${pages} > ${this.limits.maxPages})`);
    }
    return bytes;
  }
}
