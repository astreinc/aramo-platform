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
import { ENVELOPE_NOTIFICATION_SERVICE, type EnvelopeNotificationService } from './envelope-notification.service.js';
import { STORAGE_ACCOUNTING_PORT, type StorageAccountingPort } from './ports/storage-accounting.port.js';
import { SENDER_DIRECTORY_PORT, type SenderDirectoryPort } from './ports/sender-directory.port.js';
import { signingRecipients } from './domain/recipients.js';
import { EXECUTED_ARTIFACT_CUSTODY_PORT, type ExecutedArtifactCustodyPort } from './ports/executed-artifact-custody.port.js';

// DOC-4 (R-4-3) — executed-document production. On COMPLETED, stamp each filled
// SignatureField onto the frozen source PDF (typed text for TYPED/text fields;
// embedded image for DRAWN/UPLOADED signatures) and hold the executed bytes for
// write-back. ATS-neutral; documents-rendering is the only rendering dependency.

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Mask a contact identifier for the certificate (§341 — no unnecessary full
// email/phone). j***@example.com / ***-**-1234.
function maskEmail(email: string | null): string {
  // M-A5 §3.5 — an in-person signer may have no email.
  if (email === null) return 'no email';
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

// M-A6 §1 — field types stamped as a vector check box (MARK).
const MARK_FIELD_TYPES: ReadonlySet<string> = new Set(['CHECKBOX', 'ACKNOWLEDGEMENT']);

// M-A6 §2.5 — one certificate line per check box of a signer: its label (or a
// positional fallback) and its state.
function checkboxLines(
  fields: ReadonlyArray<{ signer_id: string | null; field_type: string; label?: string | null; page_number: number; value: string | null; filled_at: Date | null }>,
  signer_id: string,
): string[] {
  return fields
    .filter((f) => f.signer_id === signer_id && MARK_FIELD_TYPES.has(f.field_type))
    .map((f) => {
      const name = f.label !== undefined && f.label !== null && f.label.length > 0
        ? `${f.field_type === 'ACKNOWLEDGEMENT' ? 'Acknowledgement' : 'Checkbox'} "${f.label}"`
        : f.field_type === 'ACKNOWLEDGEMENT' ? `Acknowledgement (page ${f.page_number + 1})` : `Checkbox (page ${f.page_number + 1})`;
      return `${name}: ${f.filled_at !== null && f.value === 'true' ? 'checked' : 'not checked'}`;
    });
}

@Injectable()
export class ExecutionService implements ExecutionProducerPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Inject(DOCUMENT_RENDERING_PORT) private readonly rendering: DocumentRenderingPort,
    @Inject(DOCUMENT_SOURCE_PROVIDER_PORT) private readonly source: DocumentSourceProviderPort,
    // Aramo Sign launch — completion notifications (signers get their signed copy,
    // the console sender is told). Optional: unbound in the DOC-3 domain tests.
    @Optional() @Inject(ENVELOPE_NOTIFICATION_SERVICE) private readonly notifications?: EnvelopeNotificationService,
    @Optional() private readonly outbox?: OutboxService,
    // A1 — storage measurement of kept artifacts (never refuses). Last, so the
    // existing positional constructions stay valid.
    @Optional() @Inject(STORAGE_ACCOUNTING_PORT) private readonly storageAccounting?: StorageAccountingPort,
    // M-A5 §3.6 — the host's display name for the certificate's in-person line.
    @Optional() @Inject(SENDER_DIRECTORY_PORT) private readonly users?: SenderDirectoryPort,
    // SX-2 item 7 — custody upload to the Sign artifact bucket (unbound/dark = no-op).
    @Optional() @Inject(EXECUTED_ARTIFACT_CUSTODY_PORT) private readonly custody?: ExecutedArtifactCustodyPort,
  ) {}

  // M-A5 §3.6 — for each signer who signed in a HOSTED session, the host's display
  // name (the session that completed carries host_user_id).
  private async hostedBy(tenant_id: string, envelope_id: string): Promise<Map<string, string>> {
    const hosted = await this.prisma.signingSession.findMany({
      where: { tenant_id, envelope_id, origin: 'HOSTED', status: 'COMPLETED' },
      select: { signer_id: true, host_user_id: true },
    });
    const out = new Map<string, string>();
    for (const h of hosted) {
      if (h.host_user_id === null) continue;
      const host = await this.users?.findSender(tenant_id, h.host_user_id).catch(() => null);
      out.set(h.signer_id, host?.name ?? 'the sender');
    }
    return out;
  }

  async produce(tenant_id: string, envelope_id: string): Promise<ExecutedProductionResult[]> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const results: ExecutedProductionResult[] = [];
    // PX-2 — each signer's Signature ID is the hash of their SIGNER_SIGNED entry
    // in the append-only, hash-chained ledger. The stamp prints its first 15
    // characters; the execution certificate prints it in full beside the signer,
    // so a signature on the page can be matched to the certificate and ledger.
    const signedEvents = await this.prisma.signatureEvent.findMany({
      where: { tenant_id, envelope_id, event_type: 'SIGNER_SIGNED' },
      select: { signer_id: true, event_hash: true },
    });
    const signatureIds = new Map<string, string>();
    // The ledger stores the hash base64url-encoded; the Signature ID is the same
    // bytes as uppercase hex (lossless, DocuSign-style).
    for (const e of signedEvents) if (e.signer_id !== null) signatureIds.set(e.signer_id, Buffer.from(e.event_hash, 'base64url').toString('hex').toUpperCase());
    const stampFor = (signer_id: string | null): { label: string; id: string } => {
      const full = signer_id !== null ? signatureIds.get(signer_id) : undefined;
      return { label: 'Signed by:', id: full !== undefined ? `${full.slice(0, 15)}...` : '' };
    };

    for (const doc of full.documents) {
      const sourcePdf = await this.source.getSourcePdf({
        tenant_id,
        source_mode: doc.source_mode === 'OWNED' ? 'OWNED' : 'CORE_REF',
        document_ref: doc.document_ref,
        document_revision_ref: doc.document_revision_ref,
        source_object_key: doc.source_object_key,
      });
      const source_sha256 = sha256Hex(sourcePdf);

      // M-A6 §1 — check boxes (CHECKBOX, ACKNOWLEDGEMENT) are drawn whether or not
      // they were touched: an unchecked or never-checked box prints as an empty box.
      const fields = await this.prisma.signatureField.findMany({
        where: { tenant_id, envelope_document_id: doc.id, OR: [{ filled_at: { not: null } }, { field_type: { in: [...MARK_FIELD_TYPES] } }] },
      });
      const placements: PreparedField[] = [];
      for (const f of fields) {
        if (MARK_FIELD_TYPES.has(f.field_type)) {
          // M-A6 §1 — a vector check box, never the stored value as text.
          placements.push({
            field_key: f.id,
            page_number: f.page_number,
            x: f.x,
            y: f.y,
            kind: 'MARK',
            checked: f.filled_at !== null && f.value === 'true',
            ...(f.width !== null ? { width: f.width } : {}),
            ...(f.height !== null ? { height: f.height } : {}),
          });
          continue;
        }
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
            ...(f.field_type === 'SIGNATURE' ? { stamp: stampFor(f.signer_id) } : {}),
          });
        } else if (f.field_type === 'SIGNATURE' || f.field_type === 'INITIALS') {
          // PX-2 — typed signatures / initials render in the handwriting font, a
          // signature inside the DocuSign-style "Signed by:" stamp. Presentation
          // only: the stored value and the evidence are unchanged.
          placements.push({
            field_key: f.id,
            page_number: f.page_number,
            x: f.x,
            y: f.y,
            value: f.value,
            font: 'SCRIPT',
            ...(f.width !== null ? { width: f.width } : {}),
            ...(f.height !== null ? { height: f.height } : {}),
            ...(f.field_type === 'SIGNATURE' ? { stamp: stampFor(f.signer_id) } : {}),
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

      await this.recordKept(tenant_id, `esign:executed:${doc.id}`, rendered.bytes.byteLength);
      results.push({
        envelope_document_id: doc.id,
        source_sha256,
        executed_sha256: rendered.sha256,
        byte_size: rendered.bytes.byteLength,
      });
    }

    // DOC-4 (R-4-6) — human-readable execution certificate (one per envelope).
    const chainHash = (await this.repo.terminalEventHash(tenant_id, envelope_id)) ?? '';
    const hostedBy = await this.hostedBy(tenant_id, envelope_id);
    const boxes = full.documents.flatMap((d) => (d as { fields?: typeof d.fields }).fields ?? []);
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
      // M-A5 §1.2 — copy recipients are not signers and are not listed here.
      ...signingRecipients(full.signers).flatMap((s): RenderBlock[] => [
        {
          type: 'TEXT',
          text: `${s.name} <${maskEmail(s.email)}> — ${s.status}${s.signed_at ? ` signed ${s.signed_at.toISOString()}` : ''}`,
        },
        ...(signatureIds.has(s.id) ? [{ type: 'TEXT', text: `Signature ID: ${signatureIds.get(s.id) ?? ''}` } as RenderBlock] : []),
        ...(hostedBy.has(s.id)
          ? [{ type: 'TEXT', text: `Signed in person. Hosted by ${hostedBy.get(s.id) ?? ''}. Signer identity was not independently verified.` } as RenderBlock]
          : []),
        // M-A6 §2.5 — the signer's check boxes, by label, with their states.
        ...checkboxLines(boxes, s.id).map((text): RenderBlock => ({ type: 'TEXT', text })),
      ]),
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

    await this.recordKept(tenant_id, `esign:certificate:${envelope_id}`, certificate.bytes.byteLength);
    // SX-2 item 7 — post-commit custody upload; never fails completion (reconcile retries).
    await this.custody?.recordCompletion(tenant_id, envelope_id).catch(() => undefined);

    // DOC-4 (R-4-7) — enqueue the transactional-outbox event (refs only, no
    // bytes/PII). A drain publishes it to the operational bus; apps/api's
    // idempotent consumer pulls the bytes + evidence + certificate.
    if (this.outbox !== undefined) {
      await this.outbox.enqueue(this.prisma, {
        event_type: 'sign.envelope.executed.v1',
        envelope_id,
        tenant_id,
        correlation_id: randomUUID(),
        artifact_refs: {
          executed_document_ids: results.map((r) => r.envelope_document_id),
          has_certificate: true,
        },
      });
    }

    // Completion notifications (best-effort; a delivery failure never corrupts the
    // executed record — every attempt is recorded in NotificationDelivery).
    if (this.notifications !== undefined) {
      try {
        await this.notifications.envelopeCompleted(tenant_id, envelope_id);
      } catch {
        // swallowed — delivery is retryable, not an envelope-corruption condition
      }
    }

    return results;
  }

  private async recordKept(tenant_id: string, ref: string, bytes: number): Promise<void> {
    if (this.storageAccounting === undefined) return;
    try {
      await this.storageAccounting.recordKept({ tenant_id, ref, bytes });
    } catch {
      // Measurement only: a ledger failure never affects the signed record.
    }
  }
}
