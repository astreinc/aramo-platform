// Feature-Parity Directive v1.0 §1.15 — the PAdES document seal of an executed PDF.
//
// The seal is written as an INCREMENTAL UPDATE (ISO 32000-1 §7.5.6): the executed PDF's
// bytes are kept unchanged as the prefix of the sealed file, and one section is appended
// with an invisible signature field (widget on page 1), its signature dictionary, the
// updated page (or /Annots array), the updated catalog / AcroForm and a cross-reference
// section chained to the original by /Prev. So:
//   - the executed artifact's recorded SHA-256 (executed_sha256) stays verifiable: it is
//     the SHA-256 of the first `executed_byte_size` bytes of the sealed file;
//   - the signature's ByteRange covers the whole sealed file except the /Contents hex.
// Input: a PDF with a classic cross-reference table (what the Sign renderer writes,
// pdf-lib `useObjectStreams: false`). Encrypted PDFs and cross-reference streams are
// refused (DocumentSealPdfError); the caller keeps the unsealed artifact.

import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate } from 'node:crypto';

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, type PDFObject } from 'pdf-lib';

import { type DocumentSealIdentity, type DocumentSealSigningProvider, type DocumentSealTimestampSource } from '../ports/document-seal.port.js';

import { assertRsa, certificateFacts, signedAttributes, signedData } from './cms.js';

export type PadesLevel = 'PAdES-B-B' | 'PAdES-B-T';

export class DocumentSealPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentSealPdfError';
  }
}

export interface PadesSealOptions {
  provider: DocumentSealSigningProvider;
  timestamp?: DocumentSealTimestampSource | null;
  /** The claimed signing time written to the signature dictionary /M. */
  signing_time: Date;
  /** Bytes reserved for the CMS (the /Contents placeholder is twice this in hex). */
  reserved_bytes?: number;
  /** /Reason of the signature dictionary (presentation; no legal-grade claim). */
  reason?: string;
}

export interface PadesSealResult {
  sealed_bytes: Buffer;
  /** The appended incremental update: sealed_bytes = executed bytes || seal_tail. */
  seal_tail: Buffer;
  level: PadesLevel;
  byte_range: [number, number, number, number];
  signer_certificate_sha256: string;
  signer_subject: string;
}

export const DEFAULT_SEAL_RESERVED_BYTES = 32_768;
const BYTE_RANGE_WIDTH = 10;

const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1');

function serialize(obj: PDFObject): Buffer {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return Buffer.from(out);
}

// A PDF literal string with the three special characters escaped; non-ASCII refused.
function pdfLiteral(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new DocumentSealPdfError('signature dictionary text must be printable ASCII');
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

function pdfDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The byte offset of the last `startxref` value. */
function lastStartXref(bytes: Buffer): number {
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (m === null || m[1] === undefined) throw new DocumentSealPdfError('PDF trailer (startxref/%%EOF) not found');
  const offset = Number(m[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.length) throw new DocumentSealPdfError('startxref is out of range');
  return offset;
}

/** Human-readable subject of the seal certificate (e.g. "CN=..., O=..."). */
export function describeSubject(certificate_der: Buffer): string {
  try {
    return new X509Certificate(certificate_der).subject.split('\n').join(', ');
  } catch {
    return 'unknown';
  }
}

interface PreparedUpdate {
  bytes: Buffer;
  contentsStart: number; // offset of '<'
  contentsEnd: number; // offset after '>'
  byteRangeValueOffset: number; // offset of the first padded value after "[0 "
}

async function prepare(original: Buffer, signing_time: Date, reserved: number, reason: string): Promise<PreparedUpdate> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch (e) {
    throw new DocumentSealPdfError(`executed PDF could not be parsed for sealing: ${(e as Error).name}`);
  }
  if (doc.isEncrypted) throw new DocumentSealPdfError('encrypted PDFs are not sealed');
  const prevXref = lastStartXref(original);
  if (original.subarray(prevXref, prevXref + 4).toString('latin1') !== 'xref') {
    throw new DocumentSealPdfError('only PDFs with a classic cross-reference table are sealed');
  }
  const ctx = doc.context;
  const rootRef = ctx.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) throw new DocumentSealPdfError('catalog is not an indirect object');
  const page = doc.getPages()[0];
  if (page === undefined) throw new DocumentSealPdfError('PDF has no pages');

  let next = ctx.largestObjectNumber + 1;
  const sigNum = next++;
  const widgetNum = next++;
  const widgetRef = PDFRef.of(widgetNum, 0);
  const objects: Array<{ ref: PDFRef; body: Buffer | 'SIG' }> = [];

  // Page /Annots: an indirect array is updated in place; otherwise the page is.
  const annots = page.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFRef) {
    const arr = ctx.lookup(annots);
    if (!(arr instanceof PDFArray)) throw new DocumentSealPdfError('page /Annots is not an array');
    const copy = arr.clone(ctx);
    copy.push(widgetRef);
    objects.push({ ref: annots, body: serialize(copy) });
  } else {
    const pageCopy = page.node.clone(ctx) as PDFDict;
    const arr = annots instanceof PDFArray ? annots.clone(ctx) : ctx.obj([]);
    arr.push(widgetRef);
    pageCopy.set(PDFName.of('Annots'), arr);
    objects.push({ ref: page.ref, body: serialize(pageCopy) });
  }

  // Catalog /AcroForm: /Fields gains the seal field; /SigFlags 3 (SignaturesExist | AppendOnly).
  const catalog = ctx.lookup(rootRef);
  if (!(catalog instanceof PDFDict)) throw new DocumentSealPdfError('catalog is not a dictionary');
  const acroEntry = catalog.get(PDFName.of('AcroForm'));
  const withField = (form: PDFDict): PDFDict => {
    const copy = form.clone(ctx);
    const fieldsEntry = copy.get(PDFName.of('Fields'));
    const fields = fieldsEntry instanceof PDFRef ? ctx.lookup(fieldsEntry) : fieldsEntry;
    const arr = fields instanceof PDFArray ? fields.clone(ctx) : ctx.obj([]);
    arr.push(widgetRef);
    copy.set(PDFName.of('Fields'), arr);
    copy.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    return copy;
  };
  if (acroEntry instanceof PDFRef) {
    const form = ctx.lookup(acroEntry);
    if (!(form instanceof PDFDict)) throw new DocumentSealPdfError('catalog /AcroForm is not a dictionary');
    objects.push({ ref: acroEntry, body: serialize(withField(form)) });
  } else {
    const catalogCopy = catalog.clone(ctx);
    const form = acroEntry instanceof PDFDict ? acroEntry : ctx.obj({});
    catalogCopy.set(PDFName.of('AcroForm'), withField(form));
    objects.push({ ref: rootRef, body: serialize(catalogCopy) });
  }

  const widget = latin1(
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Aramo Document Seal ${sigNum}) /V ${sigNum} 0 R /F 132 /Rect [0 0 0 0] /P ${page.ref.objectNumber} ${page.ref.generationNumber} R >>`,
  );
  objects.push({ ref: widgetRef, body: widget });
  objects.push({ ref: PDFRef.of(sigNum, 0), body: 'SIG' });

  // Write the update: objects, then the xref section and trailer.
  const parts: Buffer[] = [original];
  let offset = original.length;
  const push = (b: Buffer): void => {
    parts.push(b);
    offset += b.length;
  };
  if (original[original.length - 1] !== 0x0a) push(latin1('\n'));
  const offsets = new Map<number, { gen: number; at: number }>();
  let contentsStart = -1;
  let contentsEnd = -1;
  let byteRangeValueOffset = -1;
  for (const o of objects) {
    offsets.set(o.ref.objectNumber, { gen: o.ref.generationNumber, at: offset });
    const header = latin1(`${o.ref.objectNumber} ${o.ref.generationNumber} obj\n`);
    if (o.body === 'SIG') {
      const pad = ' '.repeat(BYTE_RANGE_WIDTH);
      const head = `${o.ref.objectNumber} ${o.ref.generationNumber} obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M ${pdfLiteral(pdfDate(signing_time))} /Reason ${pdfLiteral(reason)} /ByteRange [0 `;
      byteRangeValueOffset = offset + Buffer.byteLength(head, 'latin1');
      const mid = `${pad} ${pad} ${pad}] /Contents `;
      contentsStart = byteRangeValueOffset + Buffer.byteLength(mid, 'latin1');
      const contents = `<${'0'.repeat(reserved * 2)}>`;
      contentsEnd = contentsStart + contents.length;
      push(latin1(`${head}${mid}${contents} >>\nendobj\n`));
    } else {
      push(header);
      push(o.body);
      push(latin1('\nendobj\n'));
    }
  }
  const xrefAt = offset;
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j += 1;
    xref += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k += 1) {
      const e = offsets.get(nums[k] as number) as { gen: number; at: number };
      xref += `${String(e.at).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
    }
    i = j + 1;
  }
  const trailer = ctx.trailerInfo;
  const extra = [
    trailer.Info !== undefined ? ` /Info ${trailer.Info.toString()}` : '',
    trailer.ID !== undefined ? ` /ID ${trailer.ID.toString()}` : '',
  ].join('');
  xref += `trailer\n<< /Size ${next} /Root ${rootRef.toString()}${extra} /Prev ${prevXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(latin1(xref));
  return { bytes: Buffer.concat(parts), contentsStart, contentsEnd, byteRangeValueOffset };
}

/** The signed content of a ByteRange. */
export function byteRangeContent(pdf: Buffer, range: readonly [number, number, number, number]): Buffer {
  return Buffer.concat([pdf.subarray(range[0], range[0] + range[1]), pdf.subarray(range[2], range[2] + range[3])]);
}

/**
 * Seal an executed PDF. Throws (DocumentSealPdfError, DocumentSealCmsError, provider or
 * time-stamp errors) without side effects; the caller keeps the unsealed artifact.
 */
export async function sealPdf(executed: Uint8Array, opts: PadesSealOptions): Promise<PadesSealResult> {
  const original = Buffer.from(executed);
  const reserved = opts.reserved_bytes ?? DEFAULT_SEAL_RESERVED_BYTES;
  const identity: DocumentSealIdentity = await opts.provider.identity();
  const facts = certificateFacts(identity.certificate_der);
  assertRsa(facts);

  const prepared = await prepare(original, opts.signing_time, reserved, opts.reason ?? 'Document sealed by Aramo Sign');
  const out = prepared.bytes;
  const range: [number, number, number, number] = [0, prepared.contentsStart, prepared.contentsEnd, out.length - prepared.contentsEnd];
  const values = range.slice(1).map((n) => String(n).padEnd(BYTE_RANGE_WIDTH, ' ')).join(' ');
  if (values.length !== BYTE_RANGE_WIDTH * 3 + 2) throw new DocumentSealPdfError('PDF too large for the ByteRange placeholder');
  out.write(values, prepared.byteRangeValueOffset, 'latin1');

  const contentDigest = createHash('sha256').update(byteRangeContent(out, range)).digest();
  const attrs = signedAttributes(contentDigest, facts);
  const attrsDigest = createHash('sha256').update(attrs).digest();
  const signature = await opts.provider.signDigest(identity, attrsDigest);
  // Fail closed on a provider that returned a signature the certificate does not verify.
  const publicKey = createPublicKey({ key: facts.spki_der, format: 'der', type: 'spki' });
  if (!cryptoVerify('sha256', attrs, publicKey, signature)) {
    throw new DocumentSealPdfError('seal provider signature does not verify against its certificate');
  }

  let level: PadesLevel = 'PAdES-B-B';
  let token: Buffer | undefined;
  if (opts.timestamp !== undefined && opts.timestamp !== null) {
    token = (await opts.timestamp.timestamp(createHash('sha256').update(signature).digest('hex'))).token_der;
    level = 'PAdES-B-T';
  }
  const cms = signedData({ identity, facts, signed_attributes: attrs, signature, ...(token !== undefined ? { timestamp_token_der: token } : {}) });
  if (cms.length > reserved) throw new DocumentSealPdfError(`CMS (${cms.length} bytes) exceeds the reserved ${reserved} bytes`);
  out.write(cms.toString('hex').toUpperCase(), prepared.contentsStart + 1, 'latin1');

  return {
    sealed_bytes: out,
    seal_tail: Buffer.from(out.subarray(original.length)),
    level,
    byte_range: range,
    signer_certificate_sha256: facts.sha256.toString('hex'),
    signer_subject: describeSubject(identity.certificate_der),
  };
}
