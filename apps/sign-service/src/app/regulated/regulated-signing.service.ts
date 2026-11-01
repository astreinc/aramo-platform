import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  DEFAULT_SIGN_BASE_URL,
  DOCUMENT_STORAGE_PORT,
  EsignService,
  EstampWorkflowService,
  QesWorkflowService,
  parseEstampRequest,
  signBaseUrl,
  type DocumentStoragePort,
  type EstampOrderView,
  type QesSignatureView,
  type QesStepResult,
} from '@aramo/sign';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import { PDFDocument } from 'pdf-lib';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';
import { SIGN_INDIA_ESTAMP_FEATURE, SIGN_QES_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';
import { SenderContextService } from '../sender/sender-context.service.js';
import { SenderEnvelopeService } from '../sender/sender-envelope.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.16 (QES) and §1.19 (India
// e-stamp) under Amendment A1 — the sign-service side of the two vendor-neutral workflows.
//
// Every operation is refused first by the plan capability's LAUNCH AVAILABILITY
// (`sign.qes`, `sign.india_estamp`: NOT_AVAILABLE — ESIGN_FEATURE_NOT_AVAILABLE 403), then,
// for a sender, by the S-1 visibility / ownership rules and the Business workspace rule,
// and, for a signer, by a live signing session. With no vendor contracted the bound
// adapters are disabled, so even a flipped gate refuses with reason provider_not_configured.

const QES_CALLBACK_PATH = '/qes/callback';

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

/** The redirect URI registered at the QTSP: <sign base URL>/qes/callback. */
export function qesRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${signBaseUrl(env) ?? DEFAULT_SIGN_BASE_URL}${QES_CALLBACK_PATH}`;
}

@Injectable()
export class RegulatedSigningService {
  private readonly safePdf = new SafePdfPipeline();

  constructor(
    private readonly features: SignFeatureGate,
    private readonly context: SenderContextService,
    private readonly envelopes: SenderEnvelopeService,
    private readonly engine: EsignService,
    private readonly qes: QesWorkflowService,
    private readonly estamp: EstampWorkflowService,
    private readonly storageGate: AramoSignStorageGate,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
  ) {}

  // ── Sender: QES (§1.16) ──────────────────────────────────────────────────

  async qesStatus(auth: AuthContextType, envelope_id: string, requestId: string): Promise<{ items: QesSignatureView[] }> {
    this.features.assertAvailable(SIGN_QES_FEATURE, requestId);
    await this.envelopes.assertVisible(auth, envelope_id, requestId);
    return { items: await this.qes.list(auth.tenant_id, envelope_id) };
  }

  async setSignatureLevel(auth: AuthContextType, envelope_id: string, signer_id: string, body: { signature_level?: unknown } | undefined, requestId: string): Promise<{ items: QesSignatureView[] }> {
    this.features.assertAvailable(SIGN_QES_FEATURE, requestId);
    const level = body?.signature_level;
    if (level !== 'STANDARD' && level !== 'QES') throw bad(requestId, 'signature_level must be STANDARD or QES', { field: 'signature_level' });
    await this.context.assertBusiness(auth, requestId);
    await this.envelopes.assertMayChangeEnvelope(auth, envelope_id, requestId);
    return { items: await this.qes.setSignatureLevel({ tenant_id: auth.tenant_id, envelope_id, signer_id, level, actor_ref: auth.sub }) };
  }

  // ── Sender: India e-stamp (§1.19) ────────────────────────────────────────

  async estampStatus(auth: AuthContextType, envelope_id: string, requestId: string): Promise<{ order: EstampOrderView | null }> {
    this.features.assertAvailable(SIGN_INDIA_ESTAMP_FEATURE, requestId);
    await this.envelopes.assertVisible(auth, envelope_id, requestId);
    return { order: await this.estamp.current(auth.tenant_id, envelope_id) };
  }

  async requestEstamp(auth: AuthContextType, envelope_id: string, body: Record<string, unknown> | undefined, requestId: string): Promise<{ order: EstampOrderView }> {
    this.features.assertAvailable(SIGN_INDIA_ESTAMP_FEATURE, requestId);
    const order = parseEstampRequest(body);
    await this.context.assertBusiness(auth, requestId);
    await this.envelopes.assertMayChangeEnvelope(auth, envelope_id, requestId);
    return { order: await this.estamp.request({ tenant_id: auth.tenant_id, envelope_id, actor_ref: auth.sub, order }) };
  }

  /**
   * Asks the aggregator for the certificate; once issued, the PDF is checked by the same
   * safe-PDF pipeline as an upload, counted against the storage allocation, stored as an
   * OWNED source and placed first in the envelope.
   */
  async refreshEstamp(auth: AuthContextType, envelope_id: string, requestId: string): Promise<{ order: EstampOrderView | null }> {
    this.features.assertAvailable(SIGN_INDIA_ESTAMP_FEATURE, requestId);
    await this.context.assertBusiness(auth, requestId);
    await this.envelopes.assertMayChangeEnvelope(auth, envelope_id, requestId);
    const polled = await this.estamp.poll({ tenant_id: auth.tenant_id, envelope_id, actor_ref: auth.sub });
    if (polled.kind === 'none') return { order: null };
    if (polled.kind !== 'issued') return { order: polled.order };
    let accepted: Uint8Array;
    try {
      accepted = await this.safePdf.accept(polled.pdf);
    } catch (e) {
      if (e instanceof UnsafePdfError) throw bad(requestId, `The e-stamp certificate can't be used: ${e.message}`, { reason: 'unsafe_pdf' });
      throw e;
    }
    const pdf = await PDFDocument.load(accepted);
    const pages = pdf.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
    const object_id = randomUUID();
    const plannedKey = this.storage.plannedSourceKey?.(auth.tenant_id, envelope_id, object_id) ?? `esign/source/${auth.tenant_id}/${envelope_id}/${object_id}`;
    await this.storageGate.reserveUpload(auth.tenant_id, plannedKey, accepted.byteLength, requestId);
    try {
      const stored = await this.storage.putOwnedSource({ tenant_id: auth.tenant_id, envelope_id, filename: 'estamp-certificate.pdf', content_type: 'application/pdf', bytes: accepted, object_id });
      const order = await this.estamp.attach({
        tenant_id: auth.tenant_id,
        envelope_id,
        actor_ref: auth.sub,
        order_id: polled.order_id,
        certificate: {
          certificate_number: polled.certificate_number,
          issued_at: polled.issued_at,
          source_object_key: stored.source_object_key,
          source_sha256: stored.source_sha256,
          byte_size: stored.byte_size,
          pages,
        },
      });
      return { order };
    } catch (e) {
      await this.storageGate.release(auth.tenant_id, plannedKey).catch(() => undefined);
      throw e;
    }
  }

  // ── Signer: QES (§1.16), authorized by a live signing session ────────────

  async signerQesStatus(token: string, requestId: string): Promise<{ qes: QesSignatureView | null }> {
    this.features.assertAvailable(SIGN_QES_FEATURE, requestId);
    const ctx = await this.engine.resolveSession(token);
    return { qes: await this.qes.forSigner(ctx) };
  }

  async signerQesBegin(token: string, requestId: string): Promise<QesStepResult> {
    this.features.assertAvailable(SIGN_QES_FEATURE, requestId);
    const ctx = await this.engine.resolveSession(token);
    return this.qes.beginIdentity(ctx, qesRedirectUri());
  }

  async signerQesComplete(token: string, body: { code?: unknown; state?: unknown }, requestId: string): Promise<QesStepResult> {
    this.features.assertAvailable(SIGN_QES_FEATURE, requestId);
    if (typeof body.code !== 'string' || typeof body.state !== 'string') throw bad(requestId, 'code and state are required', { field: 'code' });
    const ctx = await this.engine.resolveSession(token);
    return this.qes.complete(ctx, { code: body.code, state: body.state, redirect_uri: qesRedirectUri() });
  }
}
