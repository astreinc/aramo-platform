import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import {
  PdfLibDocumentRenderingAdapter,
  type DocumentRenderingPort,
  type PreparedField,
  type RenderedOutput,
} from '@aramo/documents-rendering';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { ExecutionService } from '../lib/execution.service.js';
import { type DocumentSourceProviderPort } from '../lib/ports/document-source-provider.port.js';

// PX-V1 F2 — proves the SignatureField model is now load-bearing end to end: a
// defined + filled field flows into ExecutionService.produce, the renderer
// receives a NON-EMPTY placement at the requested coordinates, and the executed
// PDF is actually stamped (executed_sha256 != source_sha256). This closes the
// Gate-0 finding that the executed PDF was unstamped because placements were
// always empty. Real Postgres 17 + real pdf-lib renderer.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-V1 F2 execution stamping — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sourcePdf: Uint8Array;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);

    // A real 1-page source PDF (600x800) so field (72,120) is within page bounds.
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    sourcePdf = await src.save();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('stamps a filled SIGNATURE field onto the executed PDF at its coordinates', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({
      tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true,
    });
    // Fill it (as the signer flow would) so produce picks it up.
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: 'Jane Doe', signature_method: 'TYPED', filled_at: new Date() } });

    // Capture the placements handed to the renderer, delegating to the real adapter.
    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => real.renderGenerated(model),
    };
    const source: DocumentSourceProviderPort = { getSourcePdf: async () => sourcePdf };

    const execution = new ExecutionService(prisma, repo, capturing, source);
    await execution.produce(TENANT, env.id);

    // The renderer received exactly one NON-EMPTY placement at the requested coords.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0]?.[0]).toMatchObject({ page_number: 0, x: 72, y: 120, value: 'Jane Doe' });

    // The executed PDF is actually stamped: its sha differs from the source sha.
    const executed = await prisma.executedDocument.findFirst({ where: { tenant_id: TENANT, envelope_document_id: doc.id } });
    expect(executed).not.toBeNull();
    expect(executed?.executed_sha256).not.toBe(executed?.source_sha256);
    expect((executed?.byte_size ?? 0) > 0).toBe(true);
  });

  // Aramo Sign Mobile M-A12 W1-C.4 — the profile text fields burn in as plain text at their
  // coordinates (no script font, no stamp), like TEXT; the DB CHECK accepts all five types.
  it('M-A12: FIRST_NAME, LAST_NAME, EMAIL, COMPANY and TITLE are stamped as text', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Profile fields', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'profile.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const values: Record<string, string> = { FIRST_NAME: 'Jane', LAST_NAME: 'Doe', EMAIL: 'jane@x.com', COMPANY: 'Acme', TITLE: 'Director' };
    let y = 100;
    for (const [field_type, value] of Object.entries(values)) {
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type, page_number: 0, x: 72, y, width: 180, height: 22, required: true });
      await prisma.signatureField.update({ where: { id: f.id }, data: { value, filled_at: new Date() } });
      y += 40;
    }
    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => real.renderGenerated(model),
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);
    expect(captured).toHaveLength(1);
    const placed = captured[0] ?? [];
    expect(placed.map((p) => (p as { value?: string }).value).sort()).toEqual(Object.values(values).sort());
    for (const p of placed) expect(p).not.toHaveProperty('font');
    for (const p of placed) expect(p).not.toHaveProperty('stamp');
  });

  // PX-2 — the Signature ID under a stamped signature is the signer's
  // SIGNER_SIGNED ledger hash (as uppercase hex), and the execution certificate
  // prints the same ID in full, so the two can be matched.
  it('stamps typed signatures in the Signed by frame with the ledger Signature ID, also in the certificate', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({
      tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 220, height: 48, required: true,
    });
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: 'Jane Doe', signature_method: 'TYPED', filled_at: new Date() } });
    const eventHash = await prisma.$transaction((tx) =>
      repo.appendEvent(tx, { tenant_id: TENANT, envelope_id: env.id, signer_id: signer.id, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER', actor_ref: signer.id }),
    );
    const signatureId = Buffer.from(eventHash, 'base64url').toString('hex').toUpperCase();

    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const generated: string[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);

    expect(captured[0]?.[0]).toMatchObject({ value: 'Jane Doe', font: 'SCRIPT', stamp: { label: 'Signed by:', id: `${signatureId.slice(0, 15)}...` } });
    expect(generated.join('')).toContain(`Signature ID: ${signatureId}`);
  });
  // Multi-Signer Amendment §8 — the executed PDF carries EVERY signer's signature (each
  // with that signer's own ledger Signature ID) and the certificate lists all of them.
  it('10 signers: every signature is stamped with its own Signature ID and the certificate lists every signer', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Ten party', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'ten.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: `p${i}@x.com`, name: `Party ${i}`, signing_order: i });
      const field = await repo.addField({
        tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 40, y: 40 + i * 60, width: 200, height: 40, required: true,
      });
      await prisma.signatureField.update({ where: { id: field.id }, data: { value: `Party ${i}`, signature_method: 'TYPED', filled_at: new Date() } });
      await prisma.signer.update({ where: { id: signer.id }, data: { status: 'SIGNED', signed_at: new Date() } });
      const h = await prisma.$transaction((tx) =>
        repo.appendEvent(tx, { tenant_id: TENANT, envelope_id: env.id, signer_id: signer.id, event_type: 'SIGNER_SIGNED', actor_type: 'SIGNER', actor_ref: signer.id }),
      );
      ids.push(Buffer.from(h, 'base64url').toString('hex').toUpperCase());
    }
    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const generated: string[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        return real.prepareFromSource(src, placements, opts);
      },
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);

    const placements = captured[0] ?? [];
    expect(placements).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(placements).toContainEqual(expect.objectContaining({ value: `Party ${i + 1}`, stamp: expect.objectContaining({ id: `${ids[i]!.slice(0, 15)}...` }) }));
    }
    const certificate = generated.join('');
    for (let i = 0; i < 10; i++) {
      expect(certificate).toContain(`Party ${i + 1}`);
      expect(certificate).toContain(`Signature ID: ${ids[i]}`);
    }
  });
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §3.6 / §1.2 — the certificate prints the
  // in-person line for a hosted signature (host named from the directory), shows an
  // in-person signer without an email, and does not list a copy recipient.
  it('M-A5: hosted signer gets the in-person line; a copy recipient is not listed as a signer', async () => {
    const HOST = randomUUID();
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'In person', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'ip.pdf', source_sha256: 'seed', ordinal: 1 });
    const signerId = randomUUID();
    await prisma.signer.create({ data: { id: signerId, tenant_id: TENANT, envelope_id: env.id, email: null, name: 'Walk-in Signer', signing_order: 1, status: 'SIGNED', signed_at: new Date(), recipient_kind: 'IN_PERSON_SIGNER' } });
    await prisma.signer.create({ data: { id: randomUUID(), tenant_id: TENANT, envelope_id: env.id, email: 'copy.only@x.com', name: 'Copy Only', signing_order: 2, status: 'PENDING', recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' } });
    const field = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signerId, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 200, height: 40, required: true });
    await prisma.signatureField.update({ where: { id: field.id }, data: { value: 'Walk-in Signer', signature_method: 'TYPED', filled_at: new Date() } });
    await prisma.signingSession.create({
      data: { id: randomUUID(), tenant_id: TENANT, envelope_id: env.id, signer_id: signerId, token_hash: randomUUID(), status: 'COMPLETED', expires_at: new Date(Date.now() + 60_000), origin: 'HOSTED', host_user_id: HOST },
    });
    const real = new PdfLibDocumentRenderingAdapter();
    const generated: string[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: (src, placements, opts) => real.prepareFromSource(src, placements, opts),
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const directory = { findSender: async (_t: string, id: string) => (id === HOST ? { email: 'host@x.com', name: 'Hana Host' } : null) };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf }, undefined, undefined, undefined, directory);
    await execution.produce(TENANT, env.id);
    const certificate = generated.join('');
    expect(certificate).toContain('Walk-in Signer <no email>');
    expect(certificate).toContain('Signed in person. Hosted by Hana Host. Signer identity was not independently verified.');
    expect(certificate).not.toContain('Copy Only');
    expect(certificate).not.toContain('copy.only');
  });
  // M-A6 §1 — CHECKBOX / ACKNOWLEDGEMENT values are stamped as a vector check box
  // (MARK), never as the text "true"; checked, unchecked ('false') and untouched
  // boxes all draw a box. §2.5 — the certificate lists each box's label and state.
  it('stamps check boxes as vector MARKs (no "true" text) and lists their labels and states in the certificate', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Boxes', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'boxes.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'cb@x.com', name: 'Casey', signing_order: 1 });
    const box = async (field_type: string, y: number, label: string | null, value: string | null) => {
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type, page_number: 0, x: 72, y, width: 14, height: 14, required: false });
      await prisma.signatureField.update({ where: { id: f.id }, data: { label, ...(value !== null ? { value, filled_at: new Date() } : {}) } });
      return f.id;
    };
    const checked = await box('CHECKBOX', 100, 'I agree to the terms', 'true');
    const unchecked = await box('CHECKBOX', 130, 'Send me updates', 'false');
    const untouched = await box('CHECKBOX', 160, null, null);
    const ack = await box('ACKNOWLEDGEMENT', 190, null, 'true');

    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const generated: string[] = [];
    const outputs: Uint8Array[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        const out = await real.prepareFromSource(src, placements, opts);
        outputs.push(out.bytes);
        return out;
      },
      renderGenerated: (model) => {
        generated.push(JSON.stringify(model));
        return real.renderGenerated(model);
      },
    };
    const execution = new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf });
    await execution.produce(TENANT, env.id);

    const placements = captured[0] ?? [];
    expect(placements).toHaveLength(4);
    const byId = new Map(placements.map((p) => [p.field_key, p]));
    expect(byId.get(checked)).toMatchObject({ kind: 'MARK', checked: true, x: 72, y: 100, width: 14, height: 14 });
    expect(byId.get(unchecked)).toMatchObject({ kind: 'MARK', checked: false });
    expect(byId.get(untouched)).toMatchObject({ kind: 'MARK', checked: false });
    expect(byId.get(ack)).toMatchObject({ kind: 'MARK', checked: true });
    for (const p of placements) expect(p.value).toBeUndefined();

    // The executed PDF's page content carries no text operator at all (the source
    // page is blank): no "true", no glyphs — only the vector boxes and checks.
    const executed = await PDFDocument.load(outputs[0]!);
    const contents = executed.getPage(0).node.Contents();
    let ops = '';
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const stream = executed.context.lookup(contents.get(i) as PDFRef);
        if (stream instanceof PDFRawStream) ops += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      }
    }
    expect(ops.length).toBeGreaterThan(0);
    expect(ops).not.toMatch(/Tj|TJ|BT/);
    expect(ops.toUpperCase()).not.toContain(Buffer.from('true', 'latin1').toString('hex').toUpperCase());
    expect(ops.split('\n').filter((l) => l === 'S')).toHaveLength(6); // 4 boxes + 2 checks

    const certificate = generated.join('');
    expect(certificate).toContain('Checkbox \\"I agree to the terms\\": checked');
    expect(certificate).toContain('Checkbox \\"Send me updates\\": not checked');
    expect(certificate).toContain('Checkbox (page 1): not checked');
    expect(certificate).toContain('Acknowledgement (page 1): checked');
  });

  // FIELD-PARITY-1 P0-2 — signer text is drawn INSIDE its box on the executed PDF
  // (wrap, shrink 11pt → 7pt, clip); a clipped field is recorded in the audit trail
  // (EXECUTED_DOCUMENT_RECORDED.truncated_field_keys); a legacy row with no box size
  // is drawn as before (one run at its x, y).
  it('P0-2: long signer text stays inside its box; a clipped field is recorded in the ledger', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Minutes', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'minutes.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const fill = async (field_type: string, box: { x: number; y: number; width?: number; height?: number }, value: string) => {
      const f = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type, page_number: 0, ...box, required: true });
      await prisma.signatureField.update({ where: { id: f.id }, data: { value, filled_at: new Date() } });
      return f.id;
    };
    const wrapBox = { x: 72, y: 500, width: 160, height: 40 };
    const clipBox = { x: 72, y: 300, width: 100, height: 14 };
    const minutes = 'The board approved the minutes of the previous meeting and the budget for the next quarter';
    const wrapped = await fill('TEXT', wrapBox, minutes);
    const clipped = await fill('COMPANY', clipBox, 'Very Long Company Name Holdings International Limited Partnership of the Americas');
    const legacy = await fill('TEXT', { x: 72, y: 700 }, 'Legacy');

    const real = new PdfLibDocumentRenderingAdapter();
    const captured: PreparedField[][] = [];
    const outputs: Uint8Array[] = [];
    const capturing: DocumentRenderingPort = {
      prepareFromSource: async (src, placements, opts): Promise<RenderedOutput> => {
        captured.push(placements);
        const out = await real.prepareFromSource(src, placements, opts);
        outputs.push(out.bytes);
        return out;
      },
      renderGenerated: (model) => real.renderGenerated(model),
    };
    await new ExecutionService(prisma, repo, capturing, { getSourcePdf: async () => sourcePdf }).produce(TENANT, env.id);

    const byId = new Map((captured[0] ?? []).map((p) => [p.field_key, p]));
    expect(byId.get(wrapped)).toMatchObject({ value: minutes, ...wrapBox });
    expect(byId.get(clipped)).toMatchObject(clipBox);
    expect(byId.get(legacy)).not.toHaveProperty('width');
    expect(byId.get(legacy)).not.toHaveProperty('height');

    // Every text run on the executed page: its font size and its baseline origin.
    const executed = await PDFDocument.load(outputs[0]!);
    const contents = executed.getPage(0).node.Contents();
    let ops = '';
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const stream = executed.context.lookup(contents.get(i) as PDFRef);
        if (stream instanceof PDFRawStream) ops += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      }
    }
    const runs = [...ops.matchAll(/BT\s[^B]*?\/\S+ ([\d.]+) Tf[\s\S]*?1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s+<([0-9A-Fa-f]*)> Tj[\s\S]*?ET/g)].map((m) => ({
      size: Number(m[1]), x: Number(m[2]), y: Number(m[3]), text: Buffer.from(m[4] ?? '', 'hex').toString('latin1'),
    }));
    const font = await executed.embedFont(StandardFonts.Helvetica);
    const within = (box: { x: number; y: number; width: number; height: number }) => runs.filter((r) => r.y >= box.y && r.y <= box.y + box.height);
    const insideBox = (box: { x: number; y: number; width: number; height: number }) => {
      const inBox = within(box);
      expect(inBox.length).toBeGreaterThan(0);
      for (const r of inBox) {
        expect(r.size).toBeLessThanOrEqual(11);
        expect(r.size).toBeGreaterThanOrEqual(7);
        expect(r.x).toBeGreaterThanOrEqual(box.x);
        expect(r.x + font.widthOfTextAtSize(r.text, r.size)).toBeLessThanOrEqual(box.x + box.width);
        expect(r.y - 0.207 * r.size).toBeGreaterThanOrEqual(box.y - 0.01);
        expect(r.y + 0.718 * r.size).toBeLessThanOrEqual(box.y + box.height + 0.01);
      }
      return inBox;
    };
    // The minutes text wraps over several lines and none of it is lost.
    const minuteRuns = insideBox(wrapBox);
    expect(minuteRuns.length).toBeGreaterThan(1);
    expect(minuteRuns.map((r) => r.text).join(' ')).toBe(minutes);
    // The company name is clipped to what fits at 7pt.
    const companyRuns = insideBox(clipBox);
    expect(companyRuns.every((r) => r.size === 7)).toBe(true);
    // The legacy row is one 11pt run at its own (x, y).
    expect(runs).toContainEqual({ size: 11, x: 72, y: 700, text: 'Legacy' });

    // The audit trail names the clipped field (and only it).
    const recorded = (await db.query(
      `SELECT payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'EXECUTED_DOCUMENT_RECORDED'`,
      [env.id],
    )).rows as Array<{ payload: Record<string, unknown> }>;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload['truncated_field_keys']).toEqual([clipped]);
  });
});
