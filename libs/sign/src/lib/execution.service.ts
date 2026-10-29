import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DOCUMENT_RENDERING_PORT,
  type DocumentRenderingPort,
  type PreparedField,
  type RenderBlock,
} from '@aramo/documents-rendering';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from './esign.repository.js';
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
import {
  EXECUTED_ARTIFACT_INTEGRITY_CONFLICT,
  EXECUTED_DOCUMENT_RECORDED,
  EXECUTION_CERTIFICATE_RECORDED,
  ExecutedArtifactIntegrityConflictError,
  type ExecutedArtifactKind,
  type ExecutedArtifactRecordedPayload,
} from './domain/executed-artifact-integrity.js';
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

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

// SX-1 — the certificate is rendered and inserted under the envelope row lock, so
// allow more than Prisma's 5 s interactive-transaction default.
const ARTIFACT_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

type ArtifactTx = LockingTx & Pick<PrismaService, 'executedDocument' | 'executionCertificate'>;

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
      // SX-1 item 1 — an executed document is written once. A repeated produce for
      // the same document returns the kept artifact without rendering again.
      const prior = await this.prisma.executedDocument.findUnique({
        where: { envelope_document_id: doc.id },
        select: { source_sha256: true, executed_sha256: true, byte_size: true },
      });
      if (prior !== null) {
        results.push({ envelope_document_id: doc.id, ...prior });
        continue;
      }

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

      const kept = await this.insertExecutedDocument(tenant_id, envelope_id, doc.id, {
        source_sha256,
        executed_sha256: rendered.sha256,
        bytes: rendered.bytes,
      });
      if (kept.inserted) await this.recordKept(tenant_id, `esign:executed:${doc.id}`, kept.result.byte_size);
      results.push(kept.result);
    }

    // DOC-4 (R-4-6) — human-readable execution certificate (one per envelope).
    // SX-1 item 1 — written once. A repeated produce finds the kept certificate and
    // returns: no second render, outbox event or completion notification.
    const priorCertificate = await this.prisma.executionCertificate.findUnique({ where: { envelope_id }, select: { id: true } });
    if (priorCertificate !== null) return results;

    const hostedBy = await this.hostedBy(tenant_id, envelope_id);
    const boxes = full.documents.flatMap((d) => (d as { fields?: typeof d.fields }).fields ?? []);
    const blocksFor = (chainHash: string): RenderBlock[] => [
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

    const certificate = await this.insertCertificate(tenant_id, envelope_id, blocksFor, results);
    if (!certificate.inserted) return results;

    await this.recordKept(tenant_id, `esign:certificate:${envelope_id}`, certificate.byte_size);
    // SX-2 item 7 — post-commit custody upload; never fails completion (reconcile retries).
    await this.custody?.recordCompletion(tenant_id, envelope_id).catch(() => undefined);

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

  // SX-1 items 1 and 3 — insert one executed document, never overwrite. Under the
  // envelope row lock (every artifact write for an envelope serializes on it):
  //   no row          → insert + EXECUTED_DOCUMENT_RECORDED ledger event (atomic)
  //   row, same hash  → idempotent success, nothing written
  //   row, other hash → EXECUTED_ARTIFACT_INTEGRITY_CONFLICT ledger event, then the
  //                     typed error; the row is left as it was
  // A unique violation from a writer that did not take the lock resolves the same way.
  private async insertExecutedDocument(
    tenant_id: string,
    envelope_id: string,
    envelope_document_id: string,
    attempted: { source_sha256: string; executed_sha256: string; bytes: Uint8Array },
  ): Promise<{ inserted: boolean; result: ExecutedProductionResult }> {
    type Outcome =
      | { kind: 'inserted' | 'existing'; result: ExecutedProductionResult }
      | { kind: 'conflict'; artifact_id: string; existing_sha256: string };
    const byte_size = attempted.bytes.byteLength;
    const resolveExisting = async (tx: ArtifactTx): Promise<Outcome | null> => {
      const existing = await tx.executedDocument.findUnique({
        where: { envelope_document_id },
        select: { id: true, source_sha256: true, executed_sha256: true, byte_size: true },
      });
      if (existing === null) return null;
      if (existing.executed_sha256 === attempted.executed_sha256) {
        return { kind: 'existing', result: { envelope_document_id, source_sha256: existing.source_sha256, executed_sha256: existing.executed_sha256, byte_size: existing.byte_size } };
      }
      await this.recordConflict(tx, tenant_id, envelope_id, 'EXECUTED_DOCUMENT', existing.id, envelope_document_id, existing.executed_sha256, attempted.executed_sha256);
      return { kind: 'conflict', artifact_id: existing.id, existing_sha256: existing.executed_sha256 };
    };

    const write = (): Promise<Outcome> =>
      this.prisma.$transaction(async (tx) => {
        await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
        const resolved = await resolveExisting(tx);
        if (resolved !== null) return resolved;
        const id = randomUUID();
        await tx.executedDocument.create({
          data: {
            id,
            tenant_id,
            envelope_id,
            envelope_document_id,
            source_sha256: attempted.source_sha256,
            executed_sha256: attempted.executed_sha256,
            byte_size,
            executed_bytes: Buffer.from(attempted.bytes),
          },
        });
        const payload: ExecutedArtifactRecordedPayload = {
          sha256: attempted.executed_sha256,
          byte_size,
          artifact_id: id,
          artifact_kind: 'EXECUTED_DOCUMENT',
          source_sha256: attempted.source_sha256,
          envelope_document_id,
        };
        await this.repo.appendEvent(tx, { tenant_id, envelope_id, event_type: EXECUTED_DOCUMENT_RECORDED, actor_type: 'SYSTEM', payload });
        return { kind: 'inserted', result: { envelope_document_id, source_sha256: attempted.source_sha256, executed_sha256: attempted.executed_sha256, byte_size } };
      }, ARTIFACT_TX_OPTIONS);

    let outcome: Outcome;
    try {
      outcome = await write();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      outcome = await this.prisma.$transaction(async (tx) => {
        await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
        const resolved = await resolveExisting(tx);
        if (resolved === null) throw e;
        return resolved;
      }, ARTIFACT_TX_OPTIONS);
    }
    if (outcome.kind === 'conflict') {
      throw new ExecutedArtifactIntegrityConflictError('EXECUTED_DOCUMENT', outcome.artifact_id, outcome.existing_sha256, attempted.executed_sha256);
    }
    return { inserted: outcome.kind === 'inserted', result: outcome.result };
  }

  // SX-1 items 1 and 3 — the certificate cites the ledger's event-chain hash, which
  // grows, so it is rendered, inserted and recorded under the envelope row lock in
  // one transaction (with the DOC-4 outbox event). A writer that finds a kept
  // certificate under the lock does not render again. Only a unique violation from
  // a writer outside the lock compares hashes: same → idempotent, different →
  // EXECUTED_ARTIFACT_INTEGRITY_CONFLICT.
  private async insertCertificate(
    tenant_id: string,
    envelope_id: string,
    blocksFor: (chainHash: string) => RenderBlock[],
    results: ExecutedProductionResult[],
  ): Promise<{ inserted: boolean; byte_size: number }> {
    // Set inside the transaction closure once the certificate is rendered.
    const attemptedRef: { sha: string | null } = { sha: null };
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
        const existing = await tx.executionCertificate.findUnique({ where: { envelope_id }, select: { byte_size: true } });
        if (existing !== null) return { inserted: false, byte_size: existing.byte_size };
        const terminal = await tx.signatureEvent.findFirst({
          where: { tenant_id, envelope_id },
          orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
          select: { event_hash: true },
        });
        const certificate = await this.rendering.renderGenerated({ render_schema_version: 'v1', title: 'Execution Certificate', blocks: blocksFor(terminal?.event_hash ?? '') });
        attemptedRef.sha = certificate.sha256;
        const id = randomUUID();
        const byte_size = certificate.bytes.byteLength;
        await tx.executionCertificate.create({
          data: { id, tenant_id, envelope_id, certificate_sha256: certificate.sha256, byte_size, certificate_bytes: Buffer.from(certificate.bytes) },
        });
        const payload: ExecutedArtifactRecordedPayload = {
          sha256: certificate.sha256,
          byte_size,
          artifact_id: id,
          artifact_kind: 'EXECUTION_CERTIFICATE',
          envelope_document_id: null,
        };
        await this.repo.appendEvent(tx, { tenant_id, envelope_id, event_type: EXECUTION_CERTIFICATE_RECORDED, actor_type: 'SYSTEM', payload });
        // DOC-4 (R-4-7) — enqueue the transactional-outbox event (refs only, no
        // bytes/PII) in the same transaction as the certificate. A drain publishes it
        // to the operational bus; apps/api's idempotent consumer pulls the bytes +
        // evidence + certificate.
        if (this.outbox !== undefined) {
          await this.outbox.enqueue(tx, {
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
        return { inserted: true, byte_size };
      }, ARTIFACT_TX_OPTIONS);
    } catch (e) {
      const attempted = attemptedRef.sha;
      if (!isUniqueViolation(e) || attempted === null) throw e;
      const conflict = await this.prisma.$transaction(async (tx) => {
        await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
        const existing = await tx.executionCertificate.findUnique({ where: { envelope_id }, select: { id: true, certificate_sha256: true, byte_size: true } });
        if (existing === null) throw e;
        if (existing.certificate_sha256 === attempted) return null;
        await this.recordConflict(tx, tenant_id, envelope_id, 'EXECUTION_CERTIFICATE', existing.id, null, existing.certificate_sha256, attempted);
        return existing;
      }, ARTIFACT_TX_OPTIONS);
      if (conflict !== null) {
        throw new ExecutedArtifactIntegrityConflictError('EXECUTION_CERTIFICATE', conflict.id, conflict.certificate_sha256, attempted);
      }
      return { inserted: false, byte_size: 0 };
    }
  }

  // SX-1 item 1 — the append-only record of a refused second write.
  private async recordConflict(
    tx: ArtifactTx,
    tenant_id: string,
    envelope_id: string,
    artifact_kind: ExecutedArtifactKind,
    artifact_id: string,
    envelope_document_id: string | null,
    existing_sha256: string,
    attempted_sha256: string,
  ): Promise<void> {
    await this.repo.appendEvent(tx, {
      tenant_id,
      envelope_id,
      event_type: EXECUTED_ARTIFACT_INTEGRITY_CONFLICT,
      actor_type: 'SYSTEM',
      payload: { artifact_id, artifact_kind, existing_sha256, attempted_sha256, envelope_document_id },
    });
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
