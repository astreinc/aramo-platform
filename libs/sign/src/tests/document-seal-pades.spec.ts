import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, StandardFonts } from 'pdf-lib';

import { byteRangeContent, DocumentSealPdfError, sealPdf } from '../lib/document-seal/pades.js';
import { OID } from '../lib/document-seal/cms.js';
import { context, oid, seq } from '../lib/document-seal/der.js';
import { type DocumentSealTimestampSource } from '../lib/ports/document-seal.port.js';

import { SelfSignedTestSealProvider, createSelfSignedSealIdentity, verifySealedPdf } from './fixtures/self-signed-seal-provider.js';

// Feature-Parity Directive v1.0 §1.15 — the PAdES document seal engine, verified
// cryptographically against a self-signed TEST certificate.

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function executedPdf(opts: { pages?: number; withAcroForm?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2001-01-01T00:00:00.000Z'));
  doc.setModificationDate(new Date('2001-01-01T00:00:00.000Z'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 1); i += 1) doc.addPage([600, 800]).drawText(`Executed page ${i + 1}`, { x: 72, y: 700, font, size: 12 });
  if (opts.withAcroForm === true) doc.getForm().createTextField('existing.field').addToPage(doc.getPage(0), { x: 72, y: 600 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const SIGNING_TIME = new Date('2026-11-01T12:00:00.000Z');

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('§1.15 PAdES document seal — engine', () => {
  it('produces a B-B seal whose signature validates with the test certificate', async () => {
    const provider = new SelfSignedTestSealProvider();
    const identity = await provider.identity();
    const executed = await executedPdf({ pages: 2 });
    const r = await sealPdf(executed, { provider, signing_time: SIGNING_TIME });

    expect(r.level).toBe('PAdES-B-B');
    const v = verifySealedPdf(r.sealed_bytes, identity.certificate_der);
    expect(v.sub_filter).toBe('ETSI.CAdES.detached');
    expect(v.timestamp_token_der).toBeNull();
    // PAdES baseline signed attributes; no signing-time attribute.
    expect([...v.signed_attribute_oids].sort()).toEqual([OID.contentType, OID.messageDigest, OID.signingCertificateV2].sort());
    expect(v.signed_attribute_oids).not.toContain('1.2.840.113549.1.9.5');
    expect(r.signer_certificate_sha256).toBe(sha(identity.certificate_der));
    expect(r.signer_subject).toContain('CN=Aramo Sign TEST Seal');
    expect(provider.signCalls).toBe(1);
  });

  it('is an incremental update: the executed bytes are the exact prefix (executed_sha256 still verifies)', async () => {
    const executed = await executedPdf();
    const r = await sealPdf(executed, { provider: new SelfSignedTestSealProvider(), signing_time: SIGNING_TIME });
    expect(r.sealed_bytes.subarray(0, executed.length).equals(executed)).toBe(true);
    expect(sha(r.sealed_bytes.subarray(0, executed.length))).toBe(sha(executed));
    expect(Buffer.concat([executed, r.seal_tail]).equals(r.sealed_bytes)).toBe(true);
    expect(r.byte_range[0]).toBe(0);
    expect(r.byte_range[2] + r.byte_range[3]).toBe(r.sealed_bytes.length);
    expect(r.sealed_bytes.toString('latin1')).toMatch(/\/Prev \d+ >>\nstartxref\n\d+\n%%EOF\n$/);
  });

  it('the sealed PDF reloads with an invisible signature field, SigFlags 3 and the original pages', async () => {
    const executed = await executedPdf({ pages: 3, withAcroForm: true });
    const r = await sealPdf(executed, { provider: new SelfSignedTestSealProvider(), signing_time: SIGNING_TIME });
    const doc = await PDFDocument.load(r.sealed_bytes);
    expect(doc.getPageCount()).toBe(3);
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names).toContain('existing.field');
    expect(names.some((n) => n.startsWith('Aramo Document Seal'))).toBe(true);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.get(PDFName.of('SigFlags'))?.toString()).toBe('3');
    expect(r.sealed_bytes.toString('latin1')).toContain('/M (D:20261101120000Z)');
  });

  it('B-T: the signature-time-stamp attribute carries the token issued over SHA-256(signature)', async () => {
    const provider = new SelfSignedTestSealProvider();
    const identity = await provider.identity();
    const asked: string[] = [];
    const token = seq(oid(OID.signedData), context(0, seq(oid('1.2.3.4'))));
    const tsa: DocumentSealTimestampSource = { timestamp: async (h) => (asked.push(h), { token_der: token }) };
    const r = await sealPdf(await executedPdf(), { provider, timestamp: tsa, signing_time: SIGNING_TIME });
    expect(r.level).toBe('PAdES-B-T');
    const v = verifySealedPdf(r.sealed_bytes, identity.certificate_der);
    expect(v.timestamp_token_der?.equals(token)).toBe(true);
    // The imprint is over the SignerInfo signature value (RFC 3161 Appendix A).
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects tampering: one byte changed inside the signed range breaks verification', async () => {
    const provider = new SelfSignedTestSealProvider();
    const identity = await provider.identity();
    const r = await sealPdf(await executedPdf(), { provider, signing_time: SIGNING_TIME });
    const tampered = Buffer.from(r.sealed_bytes);
    const at = tampered.indexOf('Executed page 1') >= 0 ? tampered.indexOf('Executed page 1') : 200;
    tampered[at + 1] = (tampered[at + 1] as number) ^ 0x01;
    expect(() => verifySealedPdf(tampered, identity.certificate_der)).toThrow();
    // ...and a different certificate is not accepted as the signer.
    expect(() => verifySealedPdf(r.sealed_bytes, createSelfSignedSealIdentity('Other').identity.certificate_der)).toThrow(/trusted/);
  });

  it('fails closed when the provider returns a signature its certificate does not verify', async () => {
    const provider = new SelfSignedTestSealProvider();
    provider.signDigest = async () => Buffer.alloc(256, 7);
    await expect(sealPdf(await executedPdf(), { provider, signing_time: SIGNING_TIME })).rejects.toThrow(DocumentSealPdfError);
  });

  it('refuses a PDF with a cross-reference stream and a CMS larger than the reservation', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const xrefStream = Buffer.from(await doc.save({ useObjectStreams: true }));
    await expect(sealPdf(xrefStream, { provider: new SelfSignedTestSealProvider(), signing_time: SIGNING_TIME })).rejects.toThrow(/classic cross-reference/);
    await expect(sealPdf(await executedPdf(), { provider: new SelfSignedTestSealProvider(), signing_time: SIGNING_TIME, reserved_bytes: 64 })).rejects.toThrow(/exceeds the reserved/);
    await expect(sealPdf(Buffer.from('not a pdf'), { provider: new SelfSignedTestSealProvider(), signing_time: SIGNING_TIME })).rejects.toThrow(DocumentSealPdfError);
  });

  // Independent check with a second implementation: OpenSSL verifies the detached CMS
  // over the ByteRange content and the signer chain (the self-signed TEST cert as the
  // trust anchor). Skipped where no openssl binary is on PATH.
  it.skipIf(!opensslAvailable())('OpenSSL cms -verify accepts the seal against the test certificate', async () => {
    const provider = new SelfSignedTestSealProvider();
    const r = await sealPdf(await executedPdf({ pages: 2 }), { provider, signing_time: SIGNING_TIME });
    const v = verifySealedPdf(r.sealed_bytes, (await provider.identity()).certificate_der);
    const dir = mkdtempSync(join(tmpdir(), 'aramo-seal-'));
    try {
      writeFileSync(join(dir, 'sig.der'), v.cms_der);
      writeFileSync(join(dir, 'content.bin'), byteRangeContent(r.sealed_bytes, r.byte_range));
      writeFileSync(join(dir, 'ca.pem'), provider.certificate_pem);
      const out = execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'sig.der'), '-content', join(dir, 'content.bin'), '-CAfile', join(dir, 'ca.pem'), '-purpose', 'any', '-out', join(dir, 'out.bin')], { stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toBeDefined();
      // A different byte in the content must fail OpenSSL too.
      const bad = byteRangeContent(r.sealed_bytes, r.byte_range);
      bad[10] = (bad[10] as number) ^ 0x01;
      writeFileSync(join(dir, 'content.bin'), bad);
      expect(() => execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'sig.der'), '-content', join(dir, 'content.bin'), '-CAfile', join(dir, 'ca.pem'), '-purpose', 'any', '-out', join(dir, 'out.bin')], { stdio: 'ignore' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
