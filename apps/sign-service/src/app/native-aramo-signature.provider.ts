import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type CreateEnvelopeRequest,
  type EnvelopeSummary,
  type EvidenceSummary,
  type SignatureProviderPort,
  type SignatureActor,
} from '@aramo/documents-contracts';
import {
  ENVELOPE_NOTIFICATION_SERVICE,
  type EnvelopeNotificationService,
  EsignRepository,
  EsignService,
  type IssuedSession,
  SIGNING_NOTIFICATION_PORT,
  type SigningNotificationPort,
  signBaseUrl,
} from '@aramo/sign';

import { AramoSignAllowanceGate } from './aramo-sign-allowance.gate.js';
import {
  type CreatedDocumentRef,
  type CreatedSignerRef,
  resolveAndValidateFields,
} from './envelope-field-mapper.js';

// DOC-3 §229 — the NATIVE (non-third-party) implementation of the provider-neutral
// SignatureProviderPort, backed by the E-Sign domain (libs/sign). A future
// DocuSign/AdobeSign provider implements the SAME contract without touching this.
@Injectable()
export class NativeAramoSignatureProvider implements SignatureProviderPort {
  private readonly logger = new Logger('NativeAramoSignatureProvider');

  constructor(
    private readonly repo: EsignRepository,
    private readonly service: EsignService,
    private readonly allowance: AramoSignAllowanceGate,
    @Optional() @Inject(SIGNING_NOTIFICATION_PORT) private readonly notifier?: SigningNotificationPort,
    // Aramo Sign launch — delivery records + void/decline/expiry notifications.
    @Optional() @Inject(ENVELOPE_NOTIFICATION_SERVICE) private readonly notifications?: EnvelopeNotificationService,
  ) {}

  private async summarize(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    return {
      envelope_id: full.id,
      status: full.status,
      signers: full.signers.map((s) => ({ signer_id: s.id, email: s.email, status: s.status })),
    };
  }

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary> {
    const env = await this.repo.createEnvelope({
      tenant_id: req.tenant_id,
      subject: req.subject,
      execution_mode: req.execution_mode,
      created_by: req.created_by,
      // Sign Unified Product S-1 — the internal command zone's only caller is the
      // ATS (S-6 replaces it with the authenticated, installation-scoped API).
      source_application: 'aramo-ats',
    });
    const createdDocs: CreatedDocumentRef[] = [];
    for (const doc of req.documents) {
      const row = await this.repo.addDocument({ tenant_id: req.tenant_id, envelope_id: env.id, ...doc });
      createdDocs.push({ id: row.id, ordinal: doc.ordinal });
    }
    const createdSigners: CreatedSignerRef[] = [];
    for (const signer of req.signers) {
      const row = await this.repo.addSigner({ tenant_id: req.tenant_id, envelope_id: env.id, ...signer });
      createdSigners.push({ id: row.id, signing_order: signer.signing_order });
    }
    // PX-V1 F2 — activate the SignatureField model through the create path. Fields
    // are OPTIONAL: existing ATS callers (RTR/Offer) supply none and are unchanged.
    // resolveAndValidateFields fails closed before any field row is written.
    if (req.fields !== undefined && req.fields.length > 0) {
      const toAdd = resolveAndValidateFields(req.tenant_id, req.fields, createdDocs, createdSigners);
      for (const field of toAdd) {
        await this.repo.addField(field);
      }
    }
    return this.summarize(req.tenant_id, env.id);
  }

  // OC-1 — send mints one signer session per signer; we dispatch the initial
  // SIGNATURE_REQUEST so each Talent actually receives a usable Sign Web URL. The
  // raw capability token stays ENTIRELY inside E-Sign: it is used only here, in
  // memory, to construct the signer URL, and is never persisted, logged, returned
  // to Core, or emitted in telemetry.
  //
  // PX-1 — `actor_ref` (optional) records the authenticated sender who acted;
  // the internal ATS path omits it and keeps the envelope creator as the actor.
  //
  // Multi-Provider directive §B/§C — the Aramo Sign allowance is reserved before the
  // send and charged once it is accepted (AramoSignAllowanceGate), for every caller
  // (ATS RTR/Offer and the sender console). Signer emails go out after the charge:
  // a delivery failure never un-charges an accepted send.
  async sendEnvelope(tenant_id: string, envelope_id: string, actor_ref?: string): Promise<EnvelopeSummary> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    const { sessions } = await this.allowance.guardSend(tenant_id, envelope_id, () =>
      this.service.send(tenant_id, envelope_id, actor_ref ?? env.created_by),
    );
    await this.dispatchSigningRequests(tenant_id, envelope_id, sessions);
    return this.summarize(tenant_id, envelope_id);
  }

  private async dispatchSigningRequests(tenant_id: string, envelope_id: string, sessions: IssuedSession[]): Promise<void> {
    if (this.notifier === undefined || sessions.length === 0) return;
    const base = signBaseUrl();
    if (base === null) {
      // Explicit signal (no token): the envelope is SENT but no signer link can be
      // built without a configured Sign origin.
      this.logger.warn(`SIGNATURE_REQUEST not dispatched for envelope ${envelope_id}: ARAMO_SIGN_BASE_URL (or SIGN_WEB_BASE_URL) is unset`);
      return;
    }
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signersById = new Map(full.signers.map((s) => [s.id, s]));
    const origin = base;
    for (const session of sessions) {
      const signer = signersById.get(session.signer_id);
      if (signer === undefined) continue;
      const signing_url = `${origin}/s/${session.raw_token}`;
      try {
        const result = await this.notifier.notify({
          kind: 'SIGNATURE_REQUEST',
          to_email: signer.email,
          to_name: signer.name,
          envelope_subject: full.subject,
          tenant_id,
          signing_url,
        });
        if (!result.delivered) {
          // Never falsely imply success; never log the token/url.
          this.logger.warn(`SIGNATURE_REQUEST reported not delivered — envelope ${envelope_id} signer ${signer.id}`);
        }
        await this.recordRequest(tenant_id, envelope_id, signer.id, result.delivered ? { ok: true } : { ok: false, error: 'provider reported not delivered' });
      } catch (err) {
        // A delivery-provider failure is a RETRYABLE condition, not envelope
        // corruption. Surface it explicitly (never the token/url).
        this.logger.warn(`SIGNATURE_REQUEST delivery failed — envelope ${envelope_id} signer ${signer.id}: ${(err as Error).message}`);
        await this.recordRequest(tenant_id, envelope_id, signer.id, { ok: false, error: (err as Error).message });
      }
    }
  }

  // Aramo Sign launch — the first invitation now leaves a NotificationDelivery row,
  // like reminders always did. Recording never breaks the send.
  private async recordRequest(tenant_id: string, envelope_id: string, signer_id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
    try {
      await this.notifications?.recordDispatch(tenant_id, envelope_id, signer_id, 'SIGNATURE_REQUEST', outcome);
    } catch (err) {
      this.logger.warn(`SIGNATURE_REQUEST delivery record failed — envelope ${envelope_id}: ${(err as Error).message}`);
    }
  }

  async getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    return this.summarize(tenant_id, envelope_id);
  }

  // Inside sign-service the acting party is a resolved actor ref (string); the
  // port's typed actor credential (Addendum S6) is an api-side concern and is
  // never used here.
  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string, actor?: string | SignatureActor): Promise<EnvelopeSummary> {
    const actor_ref = typeof actor === 'string' ? actor : undefined;
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    await this.service.voidEnvelope(tenant_id, envelope_id, actor_ref ?? env.created_by, reason);
    // Aramo Sign launch — recipients who had not finished learn it was withdrawn.
    try {
      await this.notifications?.envelopeVoided(tenant_id, envelope_id, reason);
    } catch (err) {
      this.logger.warn(`void notification failed — envelope ${envelope_id}: ${(err as Error).message}`);
    }
    return this.summarize(tenant_id, envelope_id);
  }

  // COMM-RECRUITER-W1 (W1-C1) — reverse-resolve the single NON-TERMINAL envelope
  // for a document revision (null = none; EnvelopeAmbiguousError when >1).
  async findEnvelopeForDocument(
    tenant_id: string,
    document_ref: string,
    document_revision_ref: string,
  ): Promise<EnvelopeSummary | null> {
    const found = await this.service.findEnvelopeForDocument(tenant_id, document_ref, document_revision_ref);
    if (found === null) return null;
    return this.summarize(tenant_id, found.envelope_id);
  }

  // COMM-RECRUITER-W1 (W1-C2) — same-envelope reminder: revoke prior session(s) +
  // mint new one(s) + append the ledger event (domain), then dispatch the
  // SIGNATURE_REMINDER link per newly-issued session and record each delivery
  // attempt. The raw capability token stays ENTIRELY inside E-Sign (used only
  // in-memory here to build the signer URL; never persisted/logged/returned).
  // signer_id (Multi-Signer M-3a) — remind one signer; omitted, everyone who may sign now.
  async remindEnvelopeSigner(tenant_id: string, envelope_id: string, actor?: string | SignatureActor, signer_id?: string): Promise<EnvelopeSummary> {
    const actor_ref = typeof actor === 'string' ? actor : undefined;
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    const { sessions } = await this.service.remindSigner(tenant_id, envelope_id, actor_ref ?? env.created_by, signer_id);
    await this.dispatchReminders(tenant_id, envelope_id, sessions);
    return this.summarize(tenant_id, envelope_id);
  }

  private async dispatchReminders(tenant_id: string, envelope_id: string, sessions: IssuedSession[]): Promise<void> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const signersById = new Map(full.signers.map((s) => [s.id, s]));
    const origin = signBaseUrl() ?? '';
    for (const session of sessions) {
      const signer = signersById.get(session.signer_id);
      if (signer === undefined) continue;
      if (this.notifier === undefined || origin === '') {
        // SIGNATURE_REMINDER evidence is still recorded as a PENDING delivery so
        // the reminder is auditable even when no delivery origin is configured.
        this.logger.warn(`SIGNATURE_REMINDER not dispatched for envelope ${envelope_id}: notifier/origin unavailable`);
        await this.repo.recordNotificationDelivery({
          tenant_id,
          envelope_id,
          signer_id: signer.id,
          notification_kind: 'SIGNATURE_REMINDER',
          status: 'PENDING',
        });
        continue;
      }
      const signing_url = `${origin}/s/${session.raw_token}`;
      try {
        const result = await this.notifier.notify({
          kind: 'SIGNATURE_REMINDER',
          to_email: signer.email,
          to_name: signer.name,
          envelope_subject: full.subject,
          tenant_id,
          signing_url,
        });
        await this.repo.recordNotificationDelivery({
          tenant_id,
          envelope_id,
          signer_id: signer.id,
          notification_kind: 'SIGNATURE_REMINDER',
          status: result.delivered ? 'SENT' : 'FAILED',
          last_error: result.delivered ? null : 'provider reported not delivered',
        });
      } catch (err) {
        this.logger.warn(`SIGNATURE_REMINDER delivery failed — envelope ${envelope_id} signer ${signer.id}: ${(err as Error).message}`);
        await this.repo.recordNotificationDelivery({
          tenant_id,
          envelope_id,
          signer_id: signer.id,
          notification_kind: 'SIGNATURE_REMINDER',
          status: 'FAILED',
          last_error: (err as Error).message,
        });
      }
    }
  }

  async getEvidence(tenant_id: string, envelope_id: string): Promise<EvidenceSummary> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    const signed = await this.service.evidenceManifest(tenant_id, envelope_id);
    return {
      envelope_id,
      status: env.status,
      event_chain_hash: signed.manifest.event_chain_hash,
      signature: signed.signature,
      signature_algorithm: signed.signature_algorithm,
      completed_at: signed.manifest.completed_at,
    };
  }

  // DOC-4 (R-4-7) — the executed-artifact PULL for the Documents write-back.
  // apps/api's idempotent consumer fetches the executed bytes + certificate
  // (base64) then stores the permanent EXECUTED + EXECUTION_CERTIFICATE
  // artifacts. Bytes never traverse the event bus; this authorized read is the
  // only bytes path. Service-to-service (authoritative tenant_id from the caller).
  async getExecutedArtifacts(tenant_id: string, envelope_id: string): Promise<ExecutedArtifactsBundle> {
    const docs = await this.repo.listExecutedDocuments(tenant_id, envelope_id);
    const cert = await this.repo.getExecutionCertificate(tenant_id, envelope_id);
    return {
      envelope_id,
      documents: docs.map((d) => ({
        envelope_document_id: d.envelope_document_id,
        document_ref: d.document_ref,
        document_revision_ref: d.document_revision_ref,
        executed_sha256: d.executed_sha256,
        byte_size: d.byte_size,
        executed_base64: Buffer.from(d.executed_bytes).toString('base64'),
      })),
      certificate:
        cert === null
          ? null
          : {
              certificate_sha256: cert.certificate_sha256,
              byte_size: cert.byte_size,
              certificate_base64: Buffer.from(cert.certificate_bytes).toString('base64'),
            },
    };
  }
}

export interface ExecutedArtifactsBundle {
  envelope_id: string;
  documents: {
    envelope_document_id: string;
    document_ref: string | null;
    document_revision_ref: string | null;
    executed_sha256: string;
    byte_size: number;
    executed_base64: string;
  }[];
  certificate: { certificate_sha256: string; byte_size: number; certificate_base64: string } | null;
}
