import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DOCUMENT_RENDERING_PORT,
  type DocumentRenderingPort,
  type PreparedField,
  type RenderBlock,
} from '@aramo/documents-rendering';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { OutboxService } from './outbox.service.js';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  type DocumentSourceProviderPort,
} from './ports/document-source-provider.port.js';
import {
  type ExecutionProducerPort,
  type ExecutedProductionResult,
} from './ports/execution-producer.port.js';
import { SIGNING_NOTIFICATION_PORT, type SigningNotificationPort } from './ports/signing-notification.port.js';

// DOC-4 (R-4-3) — executed-document production. On COMPLETED, stamp each filled
// SignatureField onto the frozen source PDF (typed text for TYPED/text fields;
// embedded image for DRAWN/UPLOADED signatures) and hold the executed bytes for
// write-back. ATS-neutral; documents-rendering is the only rendering dependency.

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Mask a contact identifier for the certificate (§341 — no unnecessary full
// email/phone). j***@example.com / ***-**-1234.
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

// Parse a `data:image/(png|jpeg);base64,...` data URL into raw bytes + format.
function parseImageDataUrl(value: string): { bytes: Uint8Array; format: 'PNG' | 'JPG' } | null {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (m === null) return null;
  const b64 = m[2];
  if (b64 === undefined) return null;
  const format = m[1] === 'png' ? 'PNG' : 'JPG';
  return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), format };
}

@Injectable()
export class ExecutionService implements ExecutionProducerPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Inject(DOCUMENT_RENDERING_PORT) private readonly rendering: DocumentRenderingPort,
    @Inject(DOCUMENT_SOURCE_PROVIDER_PORT) private readonly source: DocumentSourceProviderPort,
    @Optional() @Inject(SIGNING_NOTIFICATION_PORT) private readonly notifier?: SigningNotificationPort,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  async produce(tenant_id: string, envelope_id: string): Promise<ExecutedProductionResult[]> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const results: ExecutedProductionResult[] = [];

    for (const doc of full.documents) {
      const sourcePdf = await this.source.getSourcePdf({
        tenant_id,
        document_ref: doc.document_ref,
        document_revision_ref: doc.document_revision_ref,
      });
      const source_sha256 = sha256Hex(sourcePdf);

      const fields = await this.prisma.signatureField.findMany({
        where: { tenant_id, envelope_document_id: doc.id, filled_at: { not: null } },
      });
      const placements: PreparedField[] = [];
      for (const f of fields) {
        if (f.value === null) continue;
        const isImage = f.signature_method === 'DRAWN' || f.signature_method === 'UPLOADED';
        if (isImage) {
          const parsed = parseImageDataUrl(f.value);
          if (parsed === null) continue; // malformed image value → skip (typed fallback not applied)
          placements.push({
            field_key: f.id,
            page_number: f.page_number,
            x: f.x,
            y: f.y,
            kind: 'IMAGE',
            image_bytes: parsed.bytes,
            image_format: parsed.format,
            width: f.width ?? undefined,
            height: f.height ?? undefined,
          });
        } else {
          placements.push({ field_key: f.id, page_number: f.page_number, x: f.x, y: f.y, value: f.value });
        }
      }

      const rendered = await this.rendering.prepareFromSource(sourcePdf, placements);

      await this.prisma.executedDocument.upsert({
        where: { envelope_document_id: doc.id },
        create: {
          id: randomUUID(),
          tenant_id,
          envelope_id,
          envelope_document_id: doc.id,
          source_sha256,
          executed_sha256: rendered.sha256,
          byte_size: rendered.bytes.byteLength,
          executed_bytes: Buffer.from(rendered.bytes),
        },
        update: {
          source_sha256,
          executed_sha256: rendered.sha256,
          byte_size: rendered.bytes.byteLength,
          executed_bytes: Buffer.from(rendered.bytes),
          produced_at: new Date(),
        },
      });

      results.push({
        envelope_document_id: doc.id,
        source_sha256,
        executed_sha256: rendered.sha256,
        byte_size: rendered.bytes.byteLength,
      });
    }

    // DOC-4 (R-4-6) — human-readable execution certificate (one per envelope).
    const chainHash = (await this.repo.terminalEventHash(tenant_id, envelope_id)) ?? '';
    const blocks: RenderBlock[] = [
      { type: 'HEADING', text: `Envelope ${envelope_id}` },
      { type: 'TEXT', text: `Subject: ${full.subject}` },
      { type: 'TEXT', text: `Completed at: ${full.completed_at ? full.completed_at.toISOString() : 'pending'}` },
      { type: 'HEADING', text: 'Documents' },
      ...results.map((r): RenderBlock => ({
        type: 'TEXT',
        text: `Doc ${r.envelope_document_id} — source ${r.source_sha256.slice(0, 16)}… executed ${r.executed_sha256.slice(0, 16)}…`,
      })),
      { type: 'HEADING', text: 'Signers' },
      ...full.signers.map((s): RenderBlock => ({
        type: 'TEXT',
        text: `${s.name} <${maskEmail(s.email)}> — ${s.status}${s.signed_at ? ` signed ${s.signed_at.toISOString()}` : ''}`,
      })),
      { type: 'HEADING', text: 'Evidence' },
      { type: 'TEXT', text: `Event-chain hash: ${chainHash}` },
    ];
    const certificate = await this.rendering.renderGenerated({ render_schema_version: 'v1', title: 'Execution Certificate', blocks });
    await this.prisma.executionCertificate.upsert({
      where: { envelope_id },
      create: {
        id: randomUUID(),
        tenant_id,
        envelope_id,
        certificate_sha256: certificate.sha256,
        byte_size: certificate.bytes.byteLength,
        certificate_bytes: Buffer.from(certificate.bytes),
      },
      update: {
        certificate_sha256: certificate.sha256,
        byte_size: certificate.bytes.byteLength,
        certificate_bytes: Buffer.from(certificate.bytes),
        produced_at: new Date(),
      },
    });

    // DOC-4 (R-4-7) — enqueue the transactional-outbox event (refs only, no
    // bytes/PII). A drain publishes it to the operational bus; apps/api's
    // idempotent consumer pulls the bytes + evidence + certificate.
    if (this.outbox !== undefined) {
      await this.outbox.enqueue(this.prisma, {
        event_type: 'esign.envelope.executed.v1',
        envelope_id,
        tenant_id,
        correlation_id: randomUUID(),
        artifact_refs: {
          executed_document_ids: results.map((r) => r.envelope_document_id),
          has_certificate: true,
        },
      });
    }

    // Completion notification (best-effort; a delivery failure never corrupts the
    // executed record — the notification port is a retryable delivery boundary).
    if (this.notifier !== undefined) {
      for (const signer of full.signers) {
        try {
          await this.notifier.notify({
            kind: 'SIGNATURE_COMPLETED',
            to_email: signer.email,
            to_name: signer.name,
            envelope_subject: full.subject,
          });
        } catch {
          // swallowed — delivery is retryable, not an envelope-corruption condition
        }
      }
    }

    return results;
  }
}
