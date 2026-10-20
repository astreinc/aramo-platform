import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort, EnvelopeNotFoundError, EsignRepository } from '@aramo/sign';
import { ESIGN_SCOPE } from '@aramo/identity';
import { AllowanceService, ESIGN_ENVELOPE_ALLOWANCE } from '@aramo/subscription';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import type { ProviderFieldInput } from '@aramo/documents-contracts';
import { PDFDocument } from 'pdf-lib';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';
import { type CreatedDocumentRef, type CreatedSignerRef, resolveAndValidateFields } from '../envelope-field-mapper.js';
import { NativeAramoSignatureProvider } from '../native-aramo-signature.provider.js';

import type { SignIntegrationContext } from './sign-api.guard.js';

// Sign Unified Product S-4 (directive §4.4.5) — the Sign API: one versioned
// contract for every integrating application (the ATS first). Every operation
// runs as the token's principal, in the token's tenant, and is limited to:
//   - installation isolation: an integration acts ONLY on envelopes its own
//     application created (this installation, or — for envelopes created before
//     installations existed — the same application key in the same tenant);
//   - ownership: its own envelopes, or any of them with sign:envelope:read:all /
//     sign:envelope:manage:all;
//   - metering: every send goes through the native provider's allowance gate.
// Reference documents (Aramo Core Documents) are for FIRST_PARTY applications
// only; any application may upload PDFs.

const MAX_TITLE = 200;
const MAX_SIGNERS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateBody {
  subject?: unknown;
  documents?: unknown;
  signers?: unknown;
  fields?: unknown;
  send?: unknown;
  // Multi-Signer §4 — PARALLEL (default) | SEQUENTIAL.
  routing_mode?: unknown;
}

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

@Injectable()
export class SignApiService {
  private readonly safePdf = new SafePdfPipeline();

  constructor(
    private readonly repo: EsignRepository,
    private readonly provider: NativeAramoSignatureProvider,
    private readonly allowance: AllowanceService,
    private readonly storageGate: AramoSignStorageGate,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
  ) {}

  // D-12 — the Sign-owned availability contract (replaces direct subscription reads).
  async availability(auth: AuthContextType, integ?: SignIntegrationContext, requestId = '') {
    if (integ !== undefined) this.assertNotEventGrant(integ, requestId);
    const status = await this.allowance.getStatus(auth.tenant_id, ESIGN_ENVELOPE_ALLOWANCE);
    if (!status.subscribed) return { available: false, reason: 'NOT_SUBSCRIBED' as const, allowance: null };
    const allowance = {
      limit: status.limit,
      unlimited: status.limit === null,
      used: status.used,
      remaining: status.remaining,
      period_start: status.period_start.toISOString(),
      period_end: status.period_end.toISOString(),
      threshold: status.threshold,
    };
    const exhausted = status.remaining !== null && status.remaining <= 0;
    return { available: !exhausted, reason: exhausted ? ('LIMIT_REACHED' as const) : null, allowance };
  }

  // Addendum S6 — an event-bound grant reads ONE envelope's executed documents and
  // completion evidence, and nothing else (no availability, list, create, send,
  // remind, void or general read).
  private assertNotEventGrant(integ: SignIntegrationContext, requestId: string): void {
    if (integ.grant_kind === 'EVENT_ARTIFACT') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This grant only reads one completed document', 403, { requestId, details: { reason: 'grant_restricted' } });
    }
  }

  private async artifactEnvelope(auth: AuthContextType, integ: SignIntegrationContext, envelope_id: string, requestId: string) {
    if (integ.grant_kind !== 'EVENT_ARTIFACT') return this.visible(auth, integ, envelope_id, requestId);
    if (integ.bound_envelope_id !== envelope_id) throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
    try {
      return await this.repo.getEnvelope(auth.tenant_id, envelope_id);
    } catch (e) {
      if (e instanceof EnvelopeNotFoundError) throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
      throw e;
    }
  }

  // Loads the envelope only if this integration may see it (isolation + ownership).
  private async visible(auth: AuthContextType, integ: SignIntegrationContext, envelope_id: string, requestId: string) {
    this.assertNotEventGrant(integ, requestId);
    let env;
    try {
      env = await this.repo.getEnvelope(auth.tenant_id, envelope_id);
    } catch (e) {
      if (e instanceof EnvelopeNotFoundError) throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
      throw e;
    }
    const sameInstallation = env.installation_id === integ.installation_id;
    const legacySameApp = env.installation_id === null && env.source_application === integ.application_key;
    const owned = env.created_by === auth.sub;
    const readAll = auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_READ_ALL);
    if (!(sameInstallation || legacySameApp) || !(owned || readAll)) {
      throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
    }
    return env;
  }

  private async changeable(auth: AuthContextType, integ: SignIntegrationContext, envelope_id: string, requestId: string) {
    const env = await this.visible(auth, integ, envelope_id, requestId);
    if (env.created_by !== auth.sub && !auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Only the envelope’s sender can change it', 403, {
        requestId,
        details: { reason: 'envelope_not_owned', missing_scopes: [ESIGN_SCOPE.ENVELOPE_MANAGE_ALL] },
      });
    }
    return env;
  }

  async get(auth: AuthContextType, integ: SignIntegrationContext, id: string, requestId: string) {
    await this.visible(auth, integ, id, requestId);
    return this.provider.getEnvelope(auth.tenant_id, id);
  }

  async evidence(auth: AuthContextType, integ: SignIntegrationContext, id: string, requestId: string) {
    await this.artifactEnvelope(auth, integ, id, requestId);
    return this.provider.getEvidence(auth.tenant_id, id);
  }

  async executed(auth: AuthContextType, integ: SignIntegrationContext, id: string, requestId: string) {
    await this.artifactEnvelope(auth, integ, id, requestId);
    return this.provider.getExecutedArtifacts(auth.tenant_id, id);
  }

  async forDocument(auth: AuthContextType, integ: SignIntegrationContext, document_ref: string, revision_ref: string, requestId: string) {
    this.assertNotEventGrant(integ, requestId);
    const envelope = await this.provider.findEnvelopeForDocument(auth.tenant_id, document_ref, revision_ref);
    if (envelope === null) return { envelope: null };
    try {
      await this.visible(auth, integ, envelope.envelope_id, requestId);
    } catch {
      return { envelope: null };
    }
    return { envelope };
  }

  async send(auth: AuthContextType, integ: SignIntegrationContext, id: string, requestId: string) {
    await this.changeable(auth, integ, id, requestId);
    return this.provider.sendEnvelope(auth.tenant_id, id, auth.sub);
  }

  async remind(auth: AuthContextType, integ: SignIntegrationContext, id: string, requestId: string, signer_id?: unknown) {
    await this.changeable(auth, integ, id, requestId);
    if (signer_id !== undefined && typeof signer_id !== 'string') throw bad(requestId, 'signer_id must be a string', { field: 'signer_id' });
    return this.provider.remindEnvelopeSigner(auth.tenant_id, id, auth.sub, signer_id);
  }

  async void(auth: AuthContextType, integ: SignIntegrationContext, id: string, reason: unknown, requestId: string) {
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) throw bad(requestId, 'reason is required (at most 500 characters)');
    await this.changeable(auth, integ, id, requestId);
    return this.provider.voidEnvelope(auth.tenant_id, id, reason.trim(), auth.sub);
  }

  async create(auth: AuthContextType, integ: SignIntegrationContext, body: CreateBody, requestId: string) {
    this.assertNotEventGrant(integ, requestId);
    const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
    if (subject === '' || subject.length > MAX_TITLE) throw bad(requestId, `subject is required (at most ${MAX_TITLE} characters)`);
    if (!Array.isArray(body.documents) || body.documents.length === 0 || body.documents.length > 20) throw bad(requestId, 'documents: 1 to 20 required');
    if (!Array.isArray(body.signers) || body.signers.length === 0 || body.signers.length > MAX_SIGNERS) throw bad(requestId, `signers: 1 to ${MAX_SIGNERS} required`);
    if (body.send !== undefined && typeof body.send !== 'boolean') throw bad(requestId, 'send must be a boolean');
    if (body.send === true && !auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_SEND)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Sending needs sign:envelope:send', 403, { requestId, details: { missing_scopes: [ESIGN_SCOPE.ENVELOPE_SEND] } });
    }

    const signers = body.signers.map((raw: unknown, i: number) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
      if (name === '' || name.length > MAX_TITLE) throw bad(requestId, `signer ${i + 1} needs a name`, { index: i });
      if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, `signer ${i + 1} needs a valid email`, { index: i });
      const order = o['signing_order'] === undefined ? i + 1 : o['signing_order'];
      if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) throw bad(requestId, `signer ${i + 1}: signing_order must be a positive integer`, { index: i });
      return { name, email, signing_order: order };
    });
    // Multi-Signer §6 — refused before any write: a repeated email, and signing
    // positions that are not exactly 1..N (unique and contiguous).
    const emails = new Set<string>();
    for (const [i, s] of signers.entries()) {
      const k = s.email.toLowerCase();
      if (emails.has(k)) throw bad(requestId, `signer ${i + 1} repeats an email already on this envelope`, { index: i, reason: 'duplicate_signer_email' });
      emails.add(k);
    }
    const orders = signers.map((s) => s.signing_order).sort((a, b) => a - b);
    if (orders.some((o, i) => o !== i + 1)) throw bad(requestId, 'signing_order values must be 1 to N with no gaps or repeats', { reason: 'invalid_signing_order' });
    if (body.routing_mode !== undefined && body.routing_mode !== 'PARALLEL' && body.routing_mode !== 'SEQUENTIAL') {
      throw bad(requestId, 'routing_mode must be PARALLEL or SEQUENTIAL', { field: 'routing_mode' });
    }
    const routing_mode = (body.routing_mode ?? 'PARALLEL') as 'PARALLEL' | 'SEQUENTIAL';

    // Validate every document BEFORE any write (uploads are accepted into memory).
    type Doc =
      | { kind: 'reference'; document_ref: string; document_revision_ref: string; title: string; source_sha256: string; ordinal: number }
      | { kind: 'upload'; bytes: Uint8Array; title: string; filename: string; ordinal: number; pages: { width: number; height: number }[] };
    const docs: Doc[] = [];
    for (const [i, raw] of (body.documents as unknown[]).entries()) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const title = (typeof o['title'] === 'string' && o['title'].trim() !== '' ? o['title'].trim() : `Document ${i + 1}`).slice(0, MAX_TITLE);
      const ordinal = typeof o['ordinal'] === 'number' && Number.isInteger(o['ordinal']) ? (o['ordinal'] as number) : i;
      if (typeof o['document_ref'] === 'string' || typeof o['document_revision_ref'] === 'string') {
        if (integ.application_kind !== 'FIRST_PARTY') {
          throw bad(requestId, `document ${i + 1}: referenced documents are available to Aramo applications only; upload the PDF instead`, { index: i, reason: 'reference_not_allowed' });
        }
        if (typeof o['document_ref'] !== 'string' || typeof o['document_revision_ref'] !== 'string' || typeof o['source_sha256'] !== 'string') {
          throw bad(requestId, `document ${i + 1}: document_ref, document_revision_ref and source_sha256 are required`, { index: i });
        }
        docs.push({ kind: 'reference', document_ref: o['document_ref'], document_revision_ref: o['document_revision_ref'], title, source_sha256: o['source_sha256'], ordinal });
      } else {
        if (typeof o['content_base64'] !== 'string' || o['content_base64'].length === 0) throw bad(requestId, `document ${i + 1}: content_base64 (a PDF) is required`, { index: i });
        let accepted: Uint8Array;
        try {
          accepted = await this.safePdf.accept(new Uint8Array(Buffer.from(o['content_base64'], 'base64')));
        } catch (e) {
          if (e instanceof UnsafePdfError) throw bad(requestId, `document ${i + 1} can't be used: ${e.message}`, { index: i, reason: 'unsafe_pdf' });
          throw e;
        }
        const pdf = await PDFDocument.load(accepted);
        const filename = typeof o['filename'] === 'string' && o['filename'] !== '' ? o['filename'].slice(0, 200) : 'document.pdf';
        docs.push({ kind: 'upload', bytes: accepted, title, filename, ordinal, pages: pdf.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() })) });
      }
    }
    if (new Set(docs.map((d) => d.ordinal)).size !== docs.length) throw bad(requestId, 'document ordinals must be unique');

    // Fields are validated in full BEFORE anything is written.
    if (body.fields !== undefined && !Array.isArray(body.fields)) throw bad(requestId, 'fields must be an array');
    const fields = (body.fields ?? []) as ProviderFieldInput[];
    if (fields.length > 500) throw bad(requestId, 'at most 500 fields');
    for (const [i, f] of fields.entries()) {
      const d = docs.find((x) => x.ordinal === f?.document_ordinal);
      if (d?.kind === 'upload') {
        const page = d.pages[f.page_number];
        if (page === undefined || f.x < 0 || f.y < 0 || f.x + (f.width ?? 0) > page.width + 0.5 || f.y + (f.height ?? 0) > page.height + 0.5) {
          throw bad(requestId, `field ${i + 1} lies outside its page`, { index: i });
        }
      }
    }
    try {
      resolveAndValidateFields(
        auth.tenant_id,
        fields,
        docs.map((d) => ({ id: `doc-${d.ordinal}`, ordinal: d.ordinal })),
        signers.map((x) => ({ id: `signer-${x.signing_order}`, signing_order: x.signing_order })),
      );
    } catch (e) {
      throw bad(requestId, e instanceof Error ? e.message : 'invalid fields', { reason: 'invalid_fields' });
    }

    const env = await this.repo.createEnvelope({
      tenant_id: auth.tenant_id,
      subject,
      execution_mode: signers.length > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
      created_by: auth.sub,
      source_application: integ.application_key,
      installation_id: integ.installation_id,
      origin_actor_kind: integ.mode === 'USER' ? 'USER' : 'APPLICATION',
      routing_mode,
    });

    const createdDocs: CreatedDocumentRef[] = [];
    const reserved: string[] = [];
    try {
      for (const d of docs) {
        if (d.kind === 'reference') {
          const row = await this.repo.addDocument({
            tenant_id: auth.tenant_id,
            envelope_id: env.id,
            document_ref: d.document_ref,
            document_revision_ref: d.document_revision_ref,
            title: d.title,
            source_sha256: d.source_sha256,
            ordinal: d.ordinal,
          });
          createdDocs.push({ id: row.id, ordinal: d.ordinal });
        } else {
          const object_id = randomUUID();
          const key = `esign/source/${auth.tenant_id}/${env.id}/${object_id}`;
          await this.storageGate.reserveUpload(auth.tenant_id, key, d.bytes.byteLength, requestId);
          reserved.push(key);
          const stored = await this.storage.putOwnedSource({ tenant_id: auth.tenant_id, envelope_id: env.id, filename: d.filename, content_type: 'application/pdf', bytes: d.bytes, object_id });
          const row = await this.repo.addDocument({
            tenant_id: auth.tenant_id,
            envelope_id: env.id,
            source_mode: 'OWNED',
            source_object_key: stored.source_object_key,
            content_type: 'application/pdf',
            byte_size: stored.byte_size,
            title: d.title,
            source_sha256: stored.source_sha256,
            ordinal: d.ordinal,
          });
          createdDocs.push({ id: row.id, ordinal: d.ordinal });
        }
      }
    } catch (e) {
      for (const key of reserved) await this.storageGate.release(auth.tenant_id, key).catch(() => undefined);
      throw e;
    }

    const createdSigners: CreatedSignerRef[] = [];
    for (const s of signers) {
      const row = await this.repo.addSigner({ tenant_id: auth.tenant_id, envelope_id: env.id, ...s });
      createdSigners.push({ id: row.id, signing_order: s.signing_order });
    }
    if (fields.length > 0) {
      for (const field of resolveAndValidateFields(auth.tenant_id, fields, createdDocs, createdSigners)) await this.repo.addField(field);
    }
    if (body.send === true) return this.provider.sendEnvelope(auth.tenant_id, env.id, auth.sub);
    return this.provider.getEnvelope(auth.tenant_id, env.id);
  }
}
