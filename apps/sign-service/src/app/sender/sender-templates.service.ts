import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { EsignSenderRepository } from '@aramo/sign';

import { DOCUMENT_TEMPLATES_PORT, type DocumentTemplatesPort } from '../document-templates-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

import { DOCUMENT_TEMPLATE_READ_SCOPE, ESIGN_CREATE_SCOPE, SenderContextService } from './sender-context.service.js';
import { SenderEnvelopeService } from './sender-envelope.service.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7.2–7.4 (ADR-0034 D6,
// D7, D12; Conforming Amendment #7). "Start an envelope from a template" in the Aramo Sign
// console. Templates are Documents-owned: Sign holds NO template data and never touches the
// documents schema — it lists, previews and renders through the Documents API over the
// signed service-to-service channel (DocumentTemplatesHttpAdapter).
//
// Authorization happens HERE, before any call: the S2S request carries no user scope, so
// sign-service checks the caller's session holds document_template:read (the Sign "use"
// permission — sign:template:use/manage are removed) and, for an envelope,
// sign:envelope:create. Every route is also gated by the plan capability `sign.templates`
// (launch availability; flipping it is a PO commercial decision).
//
// The envelope is an ordinary Sign console draft (source_application 'aramo-sign') whose
// document is a CORE_REF source: the frozen DocumentRevision apps/api rendered, pinned to
// the exact template version.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_TITLE = 200;

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

function textValues(raw: unknown, requestId: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad(requestId, 'values must be an object of text values', { field: 'values' });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw bad(requestId, `value for ${k} must be text`, { field: 'values', key: k });
    out[k] = v;
  }
  return out;
}

export interface FromTemplateBody {
  template_id?: unknown;
  values?: unknown;
  subject?: unknown;
  idempotency_key?: unknown;
  // Optional first signer: the template's signature area is placed for them.
  signer?: unknown;
}

@Injectable()
export class SenderTemplatesService {
  constructor(
    @Inject(DOCUMENT_TEMPLATES_PORT) private readonly documents: DocumentTemplatesPort,
    private readonly gate: SignFeatureGate,
    private readonly context: SenderContextService,
    private readonly repo: EsignSenderRepository,
    private readonly envelopes: SenderEnvelopeService,
  ) {}

  // Plan capability first (an unavailable feature is unavailable to everyone), then the
  // session's template permission.
  private assertMayUse(auth: AuthContextType, requestId: string): void {
    this.gate.assertAvailable(SIGN_TEMPLATES_FEATURE, requestId);
    if (!auth.scopes.includes(DOCUMENT_TEMPLATE_READ_SCOPE)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'You do not have access to document templates', 403, {
        requestId,
        details: { missing_scopes: [DOCUMENT_TEMPLATE_READ_SCOPE] },
      });
    }
  }

  async list(auth: AuthContextType, requestId: string) {
    this.assertMayUse(auth, requestId);
    return this.documents.list({ tenant_id: auth.tenant_id, requestId });
  }

  async preview(auth: AuthContextType, template_id: string, body: { values?: unknown }, requestId: string) {
    this.assertMayUse(auth, requestId);
    if (!UUID_RE.test(template_id)) throw bad(requestId, 'template id must be a uuid', { field: 'id' });
    return this.documents.preview({ tenant_id: auth.tenant_id, template_id, body: { values: textValues(body?.values, requestId) }, requestId });
  }

  async createEnvelope(auth: AuthContextType, body: FromTemplateBody, requestId: string) {
    this.assertMayUse(auth, requestId);
    if (!auth.scopes.includes(ESIGN_CREATE_SCOPE)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'You cannot create envelopes', 403, { requestId, details: { missing_scopes: [ESIGN_CREATE_SCOPE] } });
    }
    await this.context.assertCanAuthor(auth, requestId);

    // Validate everything BEFORE the render (a refused request leaves no Document behind).
    const template_id = body?.template_id;
    if (typeof template_id !== 'string' || !UUID_RE.test(template_id)) throw bad(requestId, 'template_id must be a uuid', { field: 'template_id' });
    const values = textValues(body?.values, requestId);
    let subject: string | undefined;
    if (body?.subject !== undefined && body.subject !== null) {
      if (typeof body.subject !== 'string') throw bad(requestId, 'subject must be text', { field: 'subject' });
      const t = body.subject.trim();
      if (t.length > MAX_TITLE) throw bad(requestId, `subject must be at most ${MAX_TITLE} characters`, { field: 'subject' });
      if (t.length > 0) subject = t;
    }
    let idempotency_key: string = randomUUID();
    if (body?.idempotency_key !== undefined && body.idempotency_key !== null) {
      if (typeof body.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(body.idempotency_key)) {
        throw bad(requestId, 'idempotency_key must be 8-128 of A-Z a-z 0-9 _ -', { field: 'idempotency_key' });
      }
      idempotency_key = body.idempotency_key;
    }
    let signer: { name: string; email: string } | null = null;
    if (body?.signer !== undefined && body.signer !== null) {
      const o = body.signer as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
      if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, 'signer needs a name', { field: 'signer.name' });
      if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, 'signer needs a valid email', { field: 'signer.email' });
      signer = { name, email };
    }

    // 1. apps/api renders + freezes the Document (pinned version, tenant branding).
    const rendered = await this.documents.render({
      tenant_id: auth.tenant_id,
      template_id,
      idempotency_key,
      body: { values, created_by: auth.sub, client_id: null },
      requestId,
    });

    // 2. A Sign console draft holding the frozen revision as its CORE_REF source.
    const title = rendered.title.slice(0, MAX_TITLE);
    const env = await this.repo.createDraft({ tenant_id: auth.tenant_id, subject: subject ?? title, created_by: auth.sub });
    const doc = await this.repo.addDraftCoreRefDocument({
      tenant_id: auth.tenant_id,
      envelope_id: env.id,
      actor_ref: auth.sub,
      title,
      document_ref: rendered.document_id,
      document_revision_ref: rendered.document_revision_ref,
      source_sha256: rendered.source_sha256,
    });

    // 3. Optional first signer: the template's signature area (drawn by the renderer on the
    //    frozen bytes) is placed for them; the sender can add signers and fields next.
    if (signer !== null) {
      const withSigner = await this.envelopes.replaceRecipients(auth, env.id, { recipients: [signer] }, requestId);
      const signer_id = withSigner.recipients[0]?.id;
      if (signer_id !== undefined && rendered.signature_fields.length > 0) {
        await this.envelopes.replaceFields(
          auth,
          env.id,
          {
            fields: rendered.signature_fields.map((f) => ({
              envelope_document_id: doc.id,
              signer_id,
              field_type: f.field_type,
              page_number: f.page_number,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              required: true,
            })),
          },
          requestId,
        );
      }
    }

    return {
      envelope: await this.envelopes.detail(auth, env.id, requestId),
      template: { template_id: rendered.template_id, version_id: rendered.template_version_id, version_number: rendered.version_number },
      suggested_fields: rendered.signature_fields,
      field_definitions: rendered.field_definitions,
    };
  }
}
