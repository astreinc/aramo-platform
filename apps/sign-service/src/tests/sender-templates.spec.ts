import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import {
  ESIGN_S2S_SIGNATURE_HEADER,
  ESIGN_S2S_TIMESTAMP_HEADER,
  signTemplateBodyDigest,
  verifyEsignServiceRequest,
  type SignTemplateRenderResponse,
} from '@aramo/documents-contracts';

import { DocumentTemplatesHttpAdapter, type DocumentTemplatesPort } from '../app/document-templates-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderTemplatesService } from '../app/sender/sender-templates.service.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7.2–7.4.
//   - plan capability gate (sign.templates) in BOTH states (production registry =
//     NOT_AVAILABLE; a test registry = AVAILABLE)
//   - the session must hold document_template:read (and sign:envelope:create for an
//     envelope) BEFORE any Documents call
//   - the envelope is a Sign console draft whose document is the CORE_REF revision
//     apps/api rendered; sign-service writes nothing to Documents
//   - the S2S adapter signs every call, binds the POST body digest, fails closed.

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const TEMPLATE = '33333333-3333-7333-8333-333333333333';
const AVAILABLE = { [SIGN_TEMPLATES_FEATURE]: 'AVAILABLE' as const };

function auth(scopes: string[]): AuthContextType {
  return { sub: USER, tenant_id: TENANT, scopes, consumer_type: 'sign' } as unknown as AuthContextType;
}
const SENDER_SCOPES = ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'sign:contact:read', 'document_template:read'];

const RENDERED: SignTemplateRenderResponse = {
  document_id: '44444444-4444-7444-8444-444444444444',
  document_revision_ref: '55555555-5555-7555-8555-555555555555',
  source_sha256: 'a'.repeat(64),
  byte_size: 2048,
  title: 'Right to Represent',
  template_id: TEMPLATE,
  template_version_id: '66666666-6666-7666-8666-666666666666',
  version_number: 3,
  signature_fields: [
    { field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 200, height: 40 },
    { field_type: 'SIGN_DATE', page_number: 0, x: 300, y: 120, width: 120, height: 20 },
  ],
  field_definitions: [],
  signing: null,
};

// Amendment M-A6 §3.2 — a template with two SIGNER roles and one CC role.
const SIGNING: NonNullable<SignTemplateRenderResponse['signing']> = {
  roles: [
    { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
    { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
    { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
  ],
  routing_mode: 'SEQUENTIAL',
  default_subject: 'Please sign the agreement',
  default_message: 'Template message',
};
const ROLE_FIELDS = (['client', 'agency'] as const).flatMap((role_key, i) =>
  (['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'] as const).map((field_type, j) => ({ field_type, page_number: 0, x: 60 + j * 170, y: 300 - i * 90, width: 160, height: 20, role_key })),
);
const RENDERED_ROLES: SignTemplateRenderResponse = {
  ...RENDERED,
  signature_fields: ROLE_FIELDS,
  field_definitions: [
    { field_key: 'agency_initials', field_type: 'INITIALS', signer_role: 'agency', required: true, page_number: 0, x: 500, y: 40, width: 40, height: 20 },
    { field_key: 'unplaced', field_type: 'TEXT', signer_role: 'client', required: false, page_number: null, x: null, y: null, width: null, height: null },
    { field_key: 'cc_field', field_type: 'TEXT', signer_role: 'hr_copy', required: false, page_number: 0, x: 1, y: 1, width: 10, height: 10 },
  ],
  signing: SIGNING,
};
const LISTED = { template_id: TEMPLATE, signing: SIGNING };

function harness(opts: { registry?: Record<string, 'AVAILABLE' | 'NOT_AVAILABLE'>; kind?: string; roles?: boolean } = {}) {
  const documents: DocumentTemplatesPort = {
    list: vi.fn(async () => ({ items: opts.roles === true ? [LISTED as never] : [{ template_id: TEMPLATE, signing: null } as never], unavailable: [] })),
    preview: vi.fn(async () => ({}) as never),
    render: vi.fn(async () => (opts.roles === true ? RENDERED_ROLES : RENDERED)),
  };
  const gate = new SignFeatureGate(opts.registry);
  const context = { assertCanAuthor: vi.fn(async () => {
    if ((opts.kind ?? 'BUSINESS') !== 'BUSINESS') throw Object.assign(new Error('personal'), { code: 'INSUFFICIENT_PERMISSIONS' });
  }) };
  const repo = {
    createDraft: vi.fn(async () => ({ id: 'env-1', status: 'DRAFT', subject: 'Right to Represent' })),
    addDraftCoreRefDocument: vi.fn(async () => ({ id: 'edoc-1', title: 'Right to Represent', ordinal: 0 })),
    bindTemplateDraft: vi.fn(async () => []),
  };
  const envelopes = {
    replaceRecipients: vi.fn(async () => ({ recipients: [{ id: 'signer-1' }] })),
    replaceFields: vi.fn(async () => ({})),
    detail: vi.fn(async () => ({ id: 'env-1', status: 'DRAFT' })),
  };
  const svc = new SenderTemplatesService(documents, gate, context as never, repo as never, envelopes as never);
  return { svc, documents, repo, envelopes, context };
}

describe('plan capability sign.templates — NOT_AVAILABLE (the production registry)', () => {
  it('the production registry keeps sign.templates NOT_AVAILABLE (flipping it is a PO decision)', () => {
    expect(new SignFeatureGate().isAvailable(SIGN_TEMPLATES_FEATURE)).toBe(false);
  });

  it('refuses list / preview / from-template with ESIGN_FEATURE_NOT_AVAILABLE (403) and never calls Documents', async () => {
    const h = harness();
    const a = auth(SENDER_SCOPES);
    await expect(h.svc.list(a, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE', statusCode: 403 });
    await expect(h.svc.preview(a, TEMPLATE, {}, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE }, 'r')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
    expect(h.documents.list).not.toHaveBeenCalled();
    expect(h.documents.preview).not.toHaveBeenCalled();
    expect(h.documents.render).not.toHaveBeenCalled();
    expect(h.repo.createDraft).not.toHaveBeenCalled();
  });
});

describe('plan capability sign.templates — AVAILABLE (test registry)', () => {
  it('lists through the Documents API with the session tenant only', async () => {
    const h = harness({ registry: AVAILABLE });
    await h.svc.list(auth(SENDER_SCOPES), 'r');
    expect(h.documents.list).toHaveBeenCalledWith({ tenant_id: TENANT, requestId: 'r' });
  });

  it('refuses a session without document_template:read BEFORE calling Documents', async () => {
    const h = harness({ registry: AVAILABLE });
    const a = auth(SENDER_SCOPES.filter((s) => s !== 'document_template:read'));
    await expect(h.svc.list(a, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    await expect(h.svc.preview(a, TEMPLATE, {}, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE }, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(h.documents.list).not.toHaveBeenCalled();
    expect(h.documents.preview).not.toHaveBeenCalled();
    expect(h.documents.render).not.toHaveBeenCalled();
  });

  it('refuses an envelope without sign:envelope:create (template read alone is not enough)', async () => {
    const h = harness({ registry: AVAILABLE });
    await expect(h.svc.createEnvelope(auth(['sign:envelope:read', 'document_template:read']), { template_id: TEMPLATE }, 'r')).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { missing_scopes: ['sign:envelope:create'] } },
    });
    expect(h.documents.render).not.toHaveBeenCalled();
  });

  it('refuses a PERSONAL tenant before rendering', async () => {
    const h = harness({ registry: AVAILABLE, kind: 'PERSONAL' });
    await expect(h.svc.createEnvelope(auth(SENDER_SCOPES), { template_id: TEMPLATE }, 'r')).rejects.toThrow();
    expect(h.documents.render).not.toHaveBeenCalled();
  });

  it('validates the request before rendering (no Document is created for a bad request)', async () => {
    const h = harness({ registry: AVAILABLE });
    const a = auth(SENDER_SCOPES);
    await expect(h.svc.createEnvelope(a, { template_id: 'nope' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE, values: { k: 1 } }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE, signer: { name: 'A', email: 'bad' } }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE, idempotency_key: 'x' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.documents.render).not.toHaveBeenCalled();
  });

  it('happy path — Documents renders; the draft holds the CORE_REF revision; the signer gets the signature area', async () => {
    const h = harness({ registry: AVAILABLE });
    const out = await h.svc.createEnvelope(
      auth(SENDER_SCOPES),
      { template_id: TEMPLATE, values: { 'talent.full_name': 'Jordan Signer' }, idempotency_key: 'client-key-0001', signer: { name: 'Jordan Signer', email: 'jordan@x.test' } },
      'r',
    );
    expect(h.documents.render).toHaveBeenCalledWith({
      tenant_id: TENANT,
      template_id: TEMPLATE,
      idempotency_key: 'client-key-0001',
      body: { values: { 'talent.full_name': 'Jordan Signer' }, created_by: USER, client_id: null },
      requestId: 'r',
    });
    // M-A6 §3.6 — template provenance is recorded on every from-template draft.
    expect(h.repo.createDraft).toHaveBeenCalledWith({
      tenant_id: TENANT,
      subject: 'Right to Represent',
      created_by: USER,
      template_ref: TEMPLATE,
      template_version_ref: RENDERED.template_version_id,
    });
    expect(h.repo.addDraftCoreRefDocument).toHaveBeenCalledWith({
      tenant_id: TENANT,
      envelope_id: 'env-1',
      actor_ref: USER,
      title: 'Right to Represent',
      document_ref: RENDERED.document_id,
      document_revision_ref: RENDERED.document_revision_ref,
      source_sha256: RENDERED.source_sha256,
    });
    const fields = (h.envelopes.replaceFields.mock.calls[0] as unknown[])[2] as { fields: Array<Record<string, unknown>> };
    expect(fields.fields).toEqual([
      { envelope_document_id: 'edoc-1', signer_id: 'signer-1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: 200, height: 40, required: true },
      { envelope_document_id: 'edoc-1', signer_id: 'signer-1', field_type: 'SIGN_DATE', page_number: 0, x: 300, y: 120, width: 120, height: 20, required: true },
    ]);
    expect(out.template).toEqual({ template_id: TEMPLATE, version_id: RENDERED.template_version_id, version_number: 3 });
    expect(out.suggested_fields).toHaveLength(2);
  });

  it('without a signer — no recipients or fields are written; a generated idempotency key is used', async () => {
    const h = harness({ registry: AVAILABLE });
    await h.svc.createEnvelope(auth(SENDER_SCOPES), { template_id: TEMPLATE, subject: 'Custom subject' }, 'r');
    const call = (h.documents.render as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { idempotency_key: string };
    expect(call.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.repo.createDraft).toHaveBeenCalledWith({
      tenant_id: TENANT,
      subject: 'Custom subject',
      created_by: USER,
      template_ref: TEMPLATE,
      template_version_ref: RENDERED.template_version_id,
    });
    expect(h.envelopes.replaceRecipients).not.toHaveBeenCalled();
    expect(h.envelopes.replaceFields).not.toHaveBeenCalled();
  });
});

describe('sender context — templates permission + feature availability', () => {
  const tenants = {
    findById: async () => ({ id: TENANT, name: 'Acme', kind: 'BUSINESS' }),
    findSlugById: async () => 'acme',
    findOrganizationNameById: async () => 'Acme',
  };
  const identity = { findUserById: async () => ({ email: 'u@x.test', display_name: 'U' }), findMembership: async () => null, findRoleKeysForMembership: async () => [] };
  it('NOT_AVAILABLE (default) → features.templates false; permission follows document_template:read', async () => {
    const v = await new SenderContextService(tenants as never, identity as never).context(auth(SENDER_SCOPES), 'r');
    // M-A5 §3.7 — sign.in_person_signing is AVAILABLE in the production registry.
    expect(v.features).toEqual({ templates: false, in_person_signing: true });
    expect(v.permissions.templates).toBe(true);
  });
  it('AVAILABLE → features.templates true; no document_template:read → permission false', async () => {
    const v = await new SenderContextService(tenants as never, identity as never, new SignFeatureGate(AVAILABLE)).context(auth(['sign:envelope:read']), 'r');
    expect(v.features).toMatchObject({ templates: true });
    expect(v.permissions.templates).toBe(false);
  });
});

describe('DocumentTemplatesHttpAdapter — the signed Documents channel', () => {
  const saved = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'unit-secret';
    process.env['DOCUMENTS_API_URL'] = 'http://core.test';
    fetchMock = vi.fn(async () => new Response(JSON.stringify(RENDERED), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('fails closed without the secret — no request is sent', async () => {
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    await expect(new DocumentTemplatesHttpAdapter().list({ tenant_id: TENANT, requestId: 'r' })).rejects.toMatchObject({ code: 'ESIGN_SERVICE_AUTH_UNAVAILABLE', statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('render — signed (aramo-sign-s2s-v1) over the exact path + query, with the body bound by body_sha256', async () => {
    const body = { values: { 'talent.full_name': 'Jordan' }, created_by: USER, client_id: null };
    await new DocumentTemplatesHttpAdapter().render({ tenant_id: TENANT, template_id: TEMPLATE, idempotency_key: 'k-00000001', body, requestId: 'r' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const u = new URL(url);
    expect(u.pathname).toBe(`/v1/documents/esign/templates/${TEMPLATE}/render`);
    expect(u.searchParams.get('tenant_id')).toBe(TENANT);
    expect(u.searchParams.get('idempotency_key')).toBe('k-00000001');
    expect(u.searchParams.get('body_sha256')).toBe(signTemplateBodyDigest(body));
    expect(signTemplateBodyDigest(JSON.parse(init.body as string))).toBe(u.searchParams.get('body_sha256'));
    const verdict = verifyEsignServiceRequest({
      method: 'POST',
      path: u.pathname,
      rawQuery: u.search,
      timestampHeader: init.headers[ESIGN_S2S_TIMESTAMP_HEADER],
      signatureHeader: init.headers[ESIGN_S2S_SIGNATURE_HEADER],
      secret: 'unit-secret',
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('passes a typed refusal through with its status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'RTR_TEMPLATE_BINDING_MISSING', message: 'Fill in every template field', details: { binding_key: 'talent.full_name' } } }), { status: 422 }),
    );
    await expect(new DocumentTemplatesHttpAdapter().list({ tenant_id: TENANT, requestId: 'r' })).rejects.toMatchObject({
      code: 'RTR_TEMPLATE_BINDING_MISSING',
      statusCode: 422,
      context: { details: { binding_key: 'talent.full_name' } },
    });
  });

  it('a refusal of sign-service itself (401/403) never reaches the browser as a session error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'x' } }), { status: 401 }));
    await expect(new DocumentTemplatesHttpAdapter().list({ tenant_id: TENANT, requestId: 'r' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 502 });
  });
});

// Amendment M-A6 §3.5 — from-template with role binding.
describe('from-template — multi-role binding (M-A6 §3.5)', () => {
  const a = auth(SENDER_SCOPES);
  const recipients = [
    { role_key: 'agency', name: 'Agency Rep', email: 'agency@x.test' },
    { role_key: 'client', name: 'Client Signer', email: 'client@x.test' },
  ];
  const cc = [{ role_key: 'hr_copy', name: 'HR', email: 'hr@x.test' }];

  it('binds each SIGNER role once in role order, CC roles as copy recipients (ON_COMPLETION), fields through the internal path, provenance + template defaults', async () => {
    const h = harness({ registry: AVAILABLE, roles: true });
    const out = await h.svc.createEnvelope(a, { template_id: TEMPLATE, values: { 'requisition.title': 'Analyst' }, recipients, cc }, 'r');
    expect(h.repo.createDraft).toHaveBeenCalledWith({
      tenant_id: TENANT,
      subject: 'Please sign the agreement',
      created_by: USER,
      template_ref: TEMPLATE,
      template_version_ref: RENDERED.template_version_id,
    });
    const bind = (h.repo.bindTemplateDraft.mock.calls[0] as unknown[])[0] as {
      routing_mode: string;
      message: string | null;
      recipients: Array<Record<string, unknown>>;
      fields: Array<Record<string, unknown>>;
    };
    expect(bind.routing_mode).toBe('SEQUENTIAL');
    expect(bind.message).toBe('Template message');
    expect(bind.recipients).toEqual([
      { role_key: 'client', name: 'Client Signer', email: 'client@x.test', signing_order: 1, recipient_kind: 'SIGNER' },
      { role_key: 'agency', name: 'Agency Rep', email: 'agency@x.test', signing_order: 2, recipient_kind: 'SIGNER' },
      { role_key: 'hr_copy', name: 'HR', email: 'hr@x.test', signing_order: 3, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' },
    ]);
    // 6 role-block placements (SIGNER_NAME included — not limited by the public whitelist)
    // + the placed INITIALS definition; the unplaced and the CC-role definitions are skipped.
    expect(bind.fields.map((f) => `${f['role_key']}:${f['field_type']}`)).toEqual([
      'client:SIGNATURE',
      'client:SIGNER_NAME',
      'client:SIGN_DATE',
      'agency:SIGNATURE',
      'agency:SIGNER_NAME',
      'agency:SIGN_DATE',
      'agency:INITIALS',
    ]);
    expect(h.envelopes.replaceRecipients).not.toHaveBeenCalled();
    expect(h.envelopes.replaceFields).not.toHaveBeenCalled();
    expect(out.signing).toEqual(SIGNING);
  });

  it('the request overrides the template routing mode, message and subject', async () => {
    const h = harness({ registry: AVAILABLE, roles: true });
    await h.svc.createEnvelope(a, { template_id: TEMPLATE, recipients, routing_mode: 'PARALLEL', message: '  Hello  ', subject: 'Own subject' }, 'r');
    const bind = (h.repo.bindTemplateDraft.mock.calls[0] as unknown[])[0] as { routing_mode: string; message: string | null };
    expect(bind).toMatchObject({ routing_mode: 'PARALLEL', message: 'Hello' });
    expect((h.repo.createDraft.mock.calls[0] as unknown[])[0]).toMatchObject({ subject: 'Own subject' });
  });

  it('refuses every binding error BEFORE the render (no Document is created)', async () => {
    const reason = async (body: Record<string, unknown>): Promise<unknown> => {
      const h = harness({ registry: AVAILABLE, roles: true });
      try {
        await h.svc.createEnvelope(a, { template_id: TEMPLATE, ...body }, 'r');
        return 'NO_ERROR';
      } catch (e) {
        expect(h.documents.render).not.toHaveBeenCalled();
        expect(h.repo.createDraft).not.toHaveBeenCalled();
        return (e as { context?: { details?: { reason?: unknown } } }).context?.details?.reason;
      }
    };
    expect(await reason({ recipients, signer: { name: 'A', email: 'a@x.test' } })).toBe('signer_and_recipients');
    expect(await reason({ recipients: [recipients[0]] })).toBe('role_unbound');
    expect(await reason({ recipients: [...recipients, { role_key: 'client', name: 'Again', email: 'again@x.test' }] })).toBe('role_bound_twice');
    expect(await reason({ recipients: [...recipients, { role_key: 'nobody', name: 'N', email: 'n@x.test' }] })).toBe('unknown_role');
    expect(await reason({ recipients: [recipients[0], { role_key: 'hr_copy', name: 'HR', email: 'hr@x.test' }] })).toBe('role_not_signer');
    expect(await reason({ recipients, cc: [{ role_key: 'client', name: 'C', email: 'c2@x.test' }] })).toBe('role_not_cc');
    expect(await reason({ recipients, cc: [{ role_key: 'hr_copy', name: 'HR', email: 'CLIENT@x.test' }] })).toBe('duplicate_email');
    expect(await reason({ recipients, routing_mode: 'RANDOM' })).toBe('routing_mode_invalid');
    expect(await reason({ recipients: [{ role_key: 'client', name: 'C', email: 'bad' }] })).toBe('email_invalid');
    expect(await reason({ template_id: TEMPLATE, routing_mode: 'PARALLEL' })).toBe('recipients_required');
    expect(await reason({ signer: { name: 'Solo', email: 'solo@x.test' } })).toBe('template_has_roles');
  });

  it('a template without roles refuses recipients (use signer); an unknown or foreign template is not found', async () => {
    const plain = harness({ registry: AVAILABLE });
    await expect(plain.svc.createEnvelope(a, { template_id: TEMPLATE, recipients }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'template_has_no_roles' } } });
    const other = harness({ registry: AVAILABLE, roles: true });
    await expect(other.svc.createEnvelope(a, { template_id: '77777777-7777-7777-8777-777777777777', recipients }, 'r')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      statusCode: 404,
    });
    expect(other.documents.render).not.toHaveBeenCalled();
  });

  it('a version whose roles changed between choice and render is refused, never re-bound', async () => {
    const h = harness({ registry: AVAILABLE, roles: true });
    (h.documents.render as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...RENDERED_ROLES, signing: { ...SIGNING, roles: SIGNING.roles.slice(0, 1) } });
    await expect(h.svc.createEnvelope(a, { template_id: TEMPLATE, recipients }, 'r')).rejects.toMatchObject({
      code: 'TEMPLATE_VERSION_NOT_ACTIVE',
      context: { details: { reason: 'template_roles_changed' } },
    });
    expect(h.repo.createDraft).not.toHaveBeenCalled();
  });
});
