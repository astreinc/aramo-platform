import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { EsignSenderRepository, type TemplateFieldInput, type TemplateRecipientInput } from '@aramo/sign';
import { type SignTemplateSigning } from '@aramo/documents-contracts';

import { DOCUMENT_TEMPLATES_PORT, type DocumentTemplatesPort } from '../document-templates-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

import { DOCUMENT_TEMPLATE_READ_SCOPE, ESIGN_CREATE_SCOPE, SenderContextService } from './sender-context.service.js';
import { sanitizeMessage } from './envelope-contracts.js';
import { MAX_SIGNERS, ROUTING_MODES, SenderEnvelopeService } from './sender-envelope.service.js';

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
// M-A5 §1.4 — at most 10 copy recipients.
const MAX_COPY_RECIPIENTS = 10;
// The engine field types a template placement may carry (the internal path is not
// limited by the public authoring whitelist; ACKNOWLEDGEMENT is never placed by a template).
const TEMPLATE_FIELD_TYPES = new Set(['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX']);

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
  // Amendment M-A6 §3.5 — multi-role binding (mutually exclusive with `signer`): one
  // recipient per SIGNER role, optional copy recipients for CC roles, the routing mode
  // and the sender message (defaults: the template's).
  recipients?: unknown;
  cc?: unknown;
  routing_mode?: unknown;
  message?: unknown;
}

interface RoleBinding {
  role_key: string;
  name: string;
  email: string;
}

function roleBindings(raw: unknown, field: 'recipients' | 'cc', max: number, requestId: string): RoleBinding[] {
  if (!Array.isArray(raw)) throw bad(requestId, `${field} must be an array`, { field, reason: `${field}_invalid` });
  if (raw.length > max) throw bad(requestId, `at most ${max} ${field}`, { field, reason: field === 'cc' ? 'too_many_copy_recipients' : 'too_many_signers', max });
  return raw.map((r: unknown, index: number) => {
    const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const role_key = typeof o['role_key'] === 'string' ? o['role_key'] : '';
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
    if (role_key.length === 0 || role_key.length > 40) throw bad(requestId, `${field} ${index + 1} needs a role_key`, { field: `${field}.role_key`, index, reason: 'role_key_required' });
    if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, `${field} ${index + 1} needs a name`, { field: `${field}.name`, index, reason: 'name_required' });
    if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, `${field} ${index + 1} needs a valid email`, { field: `${field}.email`, index, reason: 'email_invalid' });
    return { role_key, name, email };
  });
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
    // M-A6 §3.5 — `recipients` (multi-role) and the single `signer` are mutually exclusive.
    const multi = (body?.recipients !== undefined && body.recipients !== null) || (body?.cc !== undefined && body.cc !== null);
    if (multi && body?.signer !== undefined && body.signer !== null) {
      throw bad(requestId, 'Use either signer or recipients, not both', { field: 'recipients', reason: 'signer_and_recipients' });
    }
    if (multi) return this.createMultiRole(auth, { template_id, values, subject, idempotency_key, body }, requestId);
    if (body?.routing_mode !== undefined || body?.message !== undefined) {
      throw bad(requestId, 'routing_mode and message apply to recipients', { field: 'recipients', reason: 'recipients_required' });
    }
    let signer: { name: string; email: string } | null = null;
    if (body?.signer !== undefined && body.signer !== null) {
      const o = body.signer as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
      if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, 'signer needs a name', { field: 'signer.name' });
      if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, 'signer needs a valid email', { field: 'signer.email' });
      signer = { name, email };
      // M-A6 §3.5 — a template with signing roles is bound role by role (recipients); the
      // single signer would get every role's block. Refused before the render.
      const listed = (await this.documents.list({ tenant_id: auth.tenant_id, requestId })).items.find((t) => t.template_id === template_id);
      if (listed !== undefined && (listed.signing?.roles.length ?? 0) > 0) {
        throw bad(requestId, 'This template has signing roles. Add a recipient for each role instead.', { field: 'signer', reason: 'template_has_roles' });
      }
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
    const env = await this.repo.createDraft({
      tenant_id: auth.tenant_id,
      subject: subject ?? title,
      created_by: auth.sub,
      // M-A6 §3.6 — provenance: the template + exact version the document was rendered from.
      template_ref: rendered.template_id,
      template_version_ref: rendered.template_version_id,
    });
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
      const single = rendered.signature_fields.filter((f) => f.role_key === undefined);
      if (signer_id !== undefined && single.length > 0) {
        await this.envelopes.replaceFields(
          auth,
          env.id,
          {
            fields: single.map((f) => ({
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
      signing: rendered.signing ?? null,
    };
  }

  // Amendment M-A6 §3.5 — from-template with role binding. Everything that can be refused
  // is refused BEFORE the render (a refused request leaves no Document behind): the
  // template's roles are read from the Documents list (the same set the user chose from).
  private async createMultiRole(
    auth: AuthContextType,
    input: { template_id: string; values: Record<string, string>; subject: string | undefined; idempotency_key: string; body: FromTemplateBody },
    requestId: string,
  ) {
    const { body } = input;
    const recipients = roleBindings(body.recipients ?? [], 'recipients', MAX_SIGNERS, requestId);
    const cc = body.cc === undefined || body.cc === null ? [] : roleBindings(body.cc, 'cc', MAX_COPY_RECIPIENTS, requestId);
    let routing: 'PARALLEL' | 'SEQUENTIAL' | undefined;
    if (body.routing_mode !== undefined && body.routing_mode !== null) {
      if (!(ROUTING_MODES as readonly unknown[]).includes(body.routing_mode)) {
        throw bad(requestId, 'routing_mode must be PARALLEL or SEQUENTIAL', { field: 'routing_mode', reason: 'routing_mode_invalid' });
      }
      routing = body.routing_mode as 'PARALLEL' | 'SEQUENTIAL';
    }
    const message = body.message === undefined ? undefined : sanitizeMessage(body.message, requestId);
    // Emails are distinct across every recipient, signing and copy (M-A5 §1.4).
    const seen = new Set<string>();
    for (const [i, r] of [...recipients, ...cc].entries()) {
      const k = r.email.toLowerCase();
      if (seen.has(k)) throw bad(requestId, `${r.email} is on this envelope twice`, { field: 'email', index: i, reason: 'duplicate_email' });
      seen.add(k);
    }

    const list = await this.documents.list({ tenant_id: auth.tenant_id, requestId });
    const item = list.items.find((t) => t.template_id === input.template_id);
    if (item === undefined) {
      throw new AramoError('TEMPLATE_NOT_FOUND', `template ${input.template_id} is not available to this organization`, 404, {
        requestId,
        details: { reason: 'not_a_usable_template' },
      });
    }
    const signing = item.signing ?? null;
    const bound = this.bindRoles(signing, recipients, cc, requestId);
    if (bound.some((r) => r.recipient_kind === 'RECEIVES_COPY') && !(await this.repo.recipientKindsAvailable())) {
      throw new AramoError('VALIDATION_ERROR', 'Copy recipients are not available yet', 422, { requestId, details: { field: 'cc', reason: 'copy_recipients_unavailable' } });
    }

    const rendered = await this.documents.render({
      tenant_id: auth.tenant_id,
      template_id: input.template_id,
      idempotency_key: input.idempotency_key,
      body: { values: input.values, created_by: auth.sub, client_id: null },
      requestId,
    });
    // The version rendered must carry the roles that were bound (a version published in
    // between is refused, never silently re-bound).
    if (!sameRoles(signing, rendered.signing ?? null)) {
      throw new AramoError('TEMPLATE_VERSION_NOT_ACTIVE', 'The template changed while the envelope was being created. Try again.', 409, { requestId, details: { reason: 'template_roles_changed' } });
    }

    const title = rendered.title.slice(0, MAX_TITLE);
    const env = await this.repo.createDraft({
      tenant_id: auth.tenant_id,
      subject: (input.subject ?? signing?.default_subject ?? title).slice(0, MAX_TITLE),
      created_by: auth.sub,
      template_ref: rendered.template_id,
      template_version_ref: rendered.template_version_id,
    });
    const doc = await this.repo.addDraftCoreRefDocument({
      tenant_id: auth.tenant_id,
      envelope_id: env.id,
      actor_ref: auth.sub,
      title,
      document_ref: rendered.document_id,
      document_revision_ref: rendered.document_revision_ref,
      source_sha256: rendered.source_sha256,
    });
    const signerKeys = new Set(bound.filter((r) => r.recipient_kind === 'SIGNER').map((r) => r.role_key));
    const fields: TemplateFieldInput[] = [];
    for (const f of rendered.signature_fields) {
      if (f.role_key === undefined || !signerKeys.has(f.role_key)) continue;
      fields.push({ envelope_document_id: doc.id, role_key: f.role_key, field_type: f.field_type, page_number: f.page_number, x: f.x, y: f.y, width: f.width, height: f.height, required: true });
    }
    // UPLOADED_PDF field definitions placed per role (TemplateFieldDefinition.signer_role).
    for (const d of rendered.field_definitions) {
      if (d.signer_role === null || !signerKeys.has(d.signer_role) || !TEMPLATE_FIELD_TYPES.has(d.field_type)) continue;
      if (d.page_number === null || d.x === null || d.y === null || d.width === null || d.height === null) continue;
      fields.push({ envelope_document_id: doc.id, role_key: d.signer_role, field_type: d.field_type, page_number: d.page_number, x: d.x, y: d.y, width: d.width, height: d.height, required: d.required });
    }
    await this.repo.bindTemplateDraft({
      tenant_id: auth.tenant_id,
      envelope_id: env.id,
      routing_mode: routing ?? signing?.routing_mode ?? 'PARALLEL',
      message: message !== undefined ? message : (signing?.default_message ?? null),
      recipients: bound,
      fields,
    });

    return {
      envelope: await this.envelopes.detail(auth, env.id, requestId),
      template: { template_id: rendered.template_id, version_id: rendered.template_version_id, version_number: rendered.version_number },
      suggested_fields: rendered.signature_fields,
      field_definitions: rendered.field_definitions,
      signing: rendered.signing ?? null,
    };
  }

  // Each SIGNER role exactly once; CC roles at most once (copy recipients); signing_order
  // follows role order — signing roles first (1..N), copy recipients after them (their
  // order is for storage uniqueness only, M-A5 §1.6).
  private bindRoles(signing: SignTemplateSigning | null, recipients: readonly RoleBinding[], cc: readonly RoleBinding[], requestId: string): TemplateRecipientInput[] {
    if (signing === null) {
      throw bad(requestId, 'This template has no signing roles. Use signer instead.', { field: 'recipients', reason: 'template_has_no_roles' });
    }
    const roles = [...signing.roles].sort((a, b) => a.order - b.order);
    const byKey = new Map(roles.map((r) => [r.role_key, r]));
    const signerBound = new Map<string, RoleBinding>();
    for (const [index, r] of recipients.entries()) {
      const role = byKey.get(r.role_key);
      if (role === undefined) throw bad(requestId, `${r.role_key} is not a role of this template`, { field: 'recipients.role_key', index, reason: 'unknown_role' });
      if (role.kind !== 'SIGNER') throw bad(requestId, `${role.label} receives a copy; add it under cc`, { field: 'recipients.role_key', index, reason: 'role_not_signer' });
      if (signerBound.has(r.role_key)) throw bad(requestId, `${role.label} is bound twice`, { field: 'recipients.role_key', index, reason: 'role_bound_twice' });
      signerBound.set(r.role_key, r);
    }
    const ccBound = new Map<string, RoleBinding>();
    for (const [index, r] of cc.entries()) {
      const role = byKey.get(r.role_key);
      if (role === undefined) throw bad(requestId, `${r.role_key} is not a role of this template`, { field: 'cc.role_key', index, reason: 'unknown_role' });
      if (role.kind !== 'CC') throw bad(requestId, `${role.label} signs; add it under recipients`, { field: 'cc.role_key', index, reason: 'role_not_cc' });
      if (ccBound.has(r.role_key)) throw bad(requestId, `${role.label} is bound twice`, { field: 'cc.role_key', index, reason: 'role_bound_twice' });
      ccBound.set(r.role_key, r);
    }
    const missing = roles.filter((r) => r.kind === 'SIGNER' && !signerBound.has(r.role_key)).map((r) => r.role_key);
    if (missing.length > 0) {
      throw bad(requestId, 'Add a recipient for every signing role', { field: 'recipients', reason: 'role_unbound', missing_roles: missing });
    }
    const out: TemplateRecipientInput[] = [];
    let order = 0;
    for (const role of roles) {
      const b = signerBound.get(role.role_key);
      if (role.kind === 'SIGNER' && b !== undefined) out.push({ ...b, signing_order: ++order, recipient_kind: 'SIGNER' });
    }
    for (const role of roles) {
      const b = ccBound.get(role.role_key);
      // Template CC roles default to delivery at completion (M-A6 §3.5; the template
      // signing schema carries no copy timing).
      if (role.kind === 'CC' && b !== undefined) out.push({ ...b, signing_order: ++order, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' });
    }
    return out;
  }
}

function sameRoles(a: SignTemplateSigning | null, b: SignTemplateSigning | null): boolean {
  if (a === null || b === null) return a === b;
  const key = (s: SignTemplateSigning): string =>
    [...s.roles]
      .sort((x, y) => x.order - y.order)
      .map((r) => `${r.role_key}:${r.kind}:${r.order}`)
      .join('|');
  return key(a) === key(b);
}
