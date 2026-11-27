import { Injectable } from '@nestjs/common';

import { UnsafePdfError } from './errors.js';
import type { PdfAttachmentRemoval } from './pdf-attachments.js';

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

// Dangerous active-content tokens. Presence => reject. PDF-ATTACH-1 (DOC-2 R-2-6 "reject/strip"):
// attached files are the one kind that is stripped, by acceptRemovingAttachments before this
// gate; an attachment still present is refused as 'attachments' (step 6), never 'scripts'.
const ACTIVE_CONTENT_TOKENS = ['/JavaScript', '/JS', '/Launch', '/OpenAction', '/AA', '/RichMedia'];

// PDF whitespace (NUL, HT, LF, FF, CR, SP) and delimiters ( ) < > [ ] { } / %
// terminate a name token (ISO 32000-1 §7.2.2). Char codes avoid a control-char regex.
const NAME_TERMINATORS = new Set([0, 9, 10, 12, 13, 32, 40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

// True when `name` (e.g. "/AA") occurs in `raw` as a COMPLETE name token.
export function containsPdfName(raw: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const i = raw.indexOf(name, from);
    if (i === -1) return false;
    const end = i + name.length;
    if (end >= raw.length || NAME_TERMINATORS.has(raw.charCodeAt(end))) return true;
    from = i + 1;
  }
}

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
    if (bytes.byteLength === 0) throw new UnsafePdfError('empty file', 'not_pdf');
    if (bytes.byteLength > this.limits.maxBytes) {
      throw new UnsafePdfError(`exceeds max size (${bytes.byteLength} > ${this.limits.maxBytes})`, 'too_large');
    }
    // 2. Type gate — PDF magic bytes "%PDF-".
    const head = Buffer.from(bytes.slice(0, 5)).toString('latin1');
    if (head !== '%PDF-') throw new UnsafePdfError('not a PDF (missing %PDF- header)', 'not_pdf');

    const raw = Buffer.from(bytes).toString('latin1');

    // 3. Encrypted/password detection — hard reject. NEVER ignoreEncryption.
    if (/\/Encrypt\b/.test(raw)) throw new UnsafePdfError('encrypted/password-protected PDF', 'password');

    // 4. Active-content policy — whole PDF NAME tokens only. A name ends at
    // whitespace or a delimiter, so /AAAAAA+Calibri (a font subset tag) is not the
    // /AA key; a bare substring test rejected ordinary Word/Chrome exports.
    for (const token of ACTIVE_CONTENT_TOKENS) {
      if (containsPdfName(raw, token)) throw new UnsafePdfError(`active content not allowed: ${token}`, 'scripts');
    }

    // 5. Structural validity + page/decompression-bomb bound — load with pdf-lib
    // (WITHOUT ignoreEncryption, so an encrypted doc that slipped the byte scan
    // still throws). Import is dynamic to keep pdf-lib strictly adapter-internal.
    const { PDFDocument } = await import('pdf-lib');
    let doc: import('pdf-lib').PDFDocument;
    try {
      doc = await PDFDocument.load(bytes);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new UnsafePdfError(`malformed or encrypted PDF: ${detail}`, /encrypt/i.test(detail) ? 'password' : 'damaged');
    }
    const pages = doc.getPageCount();
    if (pages > this.limits.maxPages) {
      throw new UnsafePdfError(`too many pages (${pages} > ${this.limits.maxPages})`, 'too_many_pages');
    }
    // 6. PDF-ATTACH-1 ATT-5 — no attached file (ATT-1) may remain, judged on the parsed object
    // graph so compressed object streams are covered too.
    const { findPdfAttachment } = await import('./pdf-attachments.js');
    const attachment = findPdfAttachment(doc);
    if (attachment !== null) throw new UnsafePdfError(`attached file not allowed: ${attachment}`, 'attachments');
    return bytes;
  }

  /**
   * PDF-ATTACH-1 ATT-2 then the gate — the upload entry point for user-supplied PDFs (Sign
   * send, the Sign API, console fixed forms). Attached files are removed first; a file without
   * any is passed through byte-for-byte (ATT-3). The e-stamp certificate path keeps `accept`
   * (a third-party legal document is never rewritten; ruling R3).
   */
  async acceptRemovingAttachments(bytes: Uint8Array): Promise<PdfAttachmentRemoval> {
    let removal: PdfAttachmentRemoval = { bytes, attachments_removed: 0 };
    // The cheap gates first: nothing too large, not a PDF, or encrypted is ever parsed here.
    const head = Buffer.from(bytes.slice(0, 5)).toString('latin1');
    if (bytes.byteLength > 0 && bytes.byteLength <= this.limits.maxBytes && head === '%PDF-' && !/\/Encrypt\b/.test(Buffer.from(bytes).toString('latin1'))) {
      const { removePdfAttachments } = await import('./pdf-attachments.js');
      removal = await removePdfAttachments(bytes);
    }
    return { bytes: await this.accept(removal.bytes), attachments_removed: removal.attachments_removed };
  }
}
