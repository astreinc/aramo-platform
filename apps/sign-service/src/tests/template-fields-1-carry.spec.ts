import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { type SignTemplateEntitlement } from '@aramo/subscription';
import { type SignTemplateRenderResponse } from '@aramo/documents-contracts';

import { type DocumentTemplatesPort } from '../app/document-templates-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';
import { SenderTemplatesService } from '../app/sender/sender-templates.service.js';

// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) F-12 (D-5) — fields placed in
// the text of an editable template reach Sign with their render positions: the multi-role and
// self paths carry them unchanged (positions plus every setting); a definition without a position
// and the single-signer path are explicit errors, never a silent drop. A sender-filled field in
// the text (no role, F-7) is attached to the first signing role.

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';
const TEMPLATE = '33333333-3333-7333-8333-333333333333';
const AVAILABLE = { [SIGN_TEMPLATES_FEATURE]: 'AVAILABLE' as const };
const a = { sub: USER, tenant_id: TENANT, scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'sign:contact:read', 'document_template:read'], consumer_type: 'sign' } as unknown as AuthContextType;

const SIGNING: NonNullable<SignTemplateRenderResponse['signing']> = {
  roles: [
    { role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 },
    { role_key: 'manager', label: 'Manager', kind: 'SIGNER', order: 2 },
  ],
  routing_mode: 'PARALLEL',
};
const INLINE = [
  { field_key: 'employee_signature', page_number: 0, x: 120.5, y: 600, width: 230, height: 50 },
  { field_key: 'policy_ack', page_number: 1, x: 300, y: 400, width: 18, height: 18 },
  { field_key: 'start_note', page_number: 1, x: 80, y: 300, width: 230, height: 22 },
];
const def = (field_key: string, field_type: string, signer_role: string | null, over: Record<string, unknown> = {}) => {
  const p = INLINE.find((f) => f.field_key === field_key);
  return { field_key, field_type, signer_role, required: true, page_number: p?.page_number ?? null, x: p?.x ?? null, y: p?.y ?? null, width: p?.width ?? null, height: p?.height ?? null, ...over };
};
const RENDERED: SignTemplateRenderResponse = {
  document_id: '44444444-4444-7444-8444-444444444444',
  document_revision_ref: '55555555-5555-7555-8555-555555555555',
  source_sha256: 'a'.repeat(64),
  byte_size: 2048,
  title: 'Employee Handbook',
  template_id: TEMPLATE,
  template_version_id: '66666666-6666-7666-8666-666666666666',
  version_number: 2,
  // The manager keeps an appended block; the employee signs inline (R-4).
  signature_fields: (['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'] as const).map((field_type, j) => ({ field_type, page_number: 1, x: 60 + j * 170, y: 200, width: 160, height: 20, role_key: 'manager' })),
  field_definitions: [
    def('employee_signature', 'SIGNATURE', 'employee'),
    def('policy_ack', 'CHECKBOX', 'employee', { required: false, label: 'IT policy' }),
    def('start_note', 'TEXT', null, { required: false, sender_filled: true }),
  ],
  signing: SIGNING,
  inline_fields: INLINE,
};

function harness(rendered: SignTemplateRenderResponse) {
  const documents: DocumentTemplatesPort = {
    list: vi.fn(async () => ({ items: [{ template_id: TEMPLATE, signing: SIGNING } as never], unavailable: [] })),
    preview: vi.fn(async () => ({}) as never),
    render: vi.fn(async () => rendered),
  };
  const repo = {
    createDraft: vi.fn(async () => ({ id: 'env-1', status: 'DRAFT', subject: 'Employee Handbook' })),
    addDraftCoreRefDocument: vi.fn(async () => ({ id: 'edoc-1', title: 'Employee Handbook', ordinal: 0 })),
    bindTemplateDraft: vi.fn(async () => []),
    replaceDraftRecipients: vi.fn(async () => [{ id: 'signer-1' }]),
  };
  const envelopes = {
    replaceRecipients: vi.fn(async () => ({ recipients: [{ id: 'signer-1' }] })),
    replaceFields: vi.fn(async () => ({})),
    detail: vi.fn(async () => ({ id: 'env-1', status: 'DRAFT' })),
    selfRecipient: vi.fn(async () => ({ name: 'Me', email: 'me@x.test' })),
  };
  const entitlements = { of: vi.fn(async (): Promise<SignTemplateEntitlement> => ({ kind: 'INCLUDED', plan_key: 'aramo-sign-standard-business-v1' })) };
  const svc = new SenderTemplatesService(documents, new SignFeatureGate(AVAILABLE), { assertCanAuthor: vi.fn(async () => undefined) } as never, repo as never, envelopes as never, entitlements as never);
  return { svc, repo, envelopes };
}
const details = (e: unknown): Record<string, unknown> => ((e as { context?: { details?: Record<string, unknown> } }).context?.details ?? {});
const recipients = [
  { role_key: 'employee', name: 'Eve Employee', email: 'eve@x.test' },
  { role_key: 'manager', name: 'Max Manager', email: 'max@x.test' },
];

describe('TEMPLATE-FIELDS-1 F-12 — inline fields carried to Sign', () => {
  const saved = process.env['SIGN_SENDER_FILLED_FIELDS_ENABLED'];
  beforeEach(() => {
    process.env['SIGN_SENDER_FILLED_FIELDS_ENABLED'] = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SIGN_SENDER_FILLED_FIELDS_ENABLED'];
    else process.env['SIGN_SENDER_FILLED_FIELDS_ENABLED'] = saved;
  });

  it('multi-role: every inline field arrives at its render position with its settings; the sender-filled one on the first role', async () => {
    const h = harness(RENDERED);
    await h.svc.createEnvelope(a, { template_id: TEMPLATE, recipients }, 'r');
    const bind = (h.repo.bindTemplateDraft.mock.calls[0] as unknown[])[0] as { fields: Array<Record<string, unknown>> };
    const inline = bind.fields.slice(3);
    expect(inline).toEqual([
      expect.objectContaining({ field_key: 'employee_signature', role_key: 'employee', field_type: 'SIGNATURE', page_number: 0, x: 120.5, y: 600, width: 230, height: 50, required: true }),
      expect.objectContaining({ field_key: 'policy_ack', role_key: 'employee', field_type: 'CHECKBOX', page_number: 1, x: 300, y: 400, label: 'IT policy', required: false }),
      expect.objectContaining({ field_key: 'start_note', role_key: 'employee', field_type: 'TEXT', sender_filled: true }),
    ]);
    // The manager's appended block is carried; the employee has none (R-4).
    expect(bind.fields.slice(0, 3).every((f) => f['role_key'] === 'manager')).toBe(true);
  });

  it('a definition without a position is refused 409 field_not_placed (was a silent skip); nothing is created', async () => {
    const h = harness({ ...RENDERED, field_definitions: [...RENDERED.field_definitions, def('employee_initials', 'INITIALS', 'employee')] });
    const e = await h.svc.createEnvelope(a, { template_id: TEMPLATE, recipients }, 'r').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'TEMPLATE_VERSION_NOT_ACTIVE', statusCode: 409 });
    expect(details(e)).toEqual({ reason: 'field_not_placed', keys: ['employee_initials'] });
    expect(h.repo.createDraft).not.toHaveBeenCalled();
  });

  it('the single-signer path is refused (signing_roles_required): it carries no field definitions', async () => {
    const h = harness(RENDERED);
    const e = await h.svc.createEnvelope(a, { template_id: TEMPLATE }, 'r').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
    expect(details(e)).toEqual({ reason: 'signing_roles_required', keys: ['employee_signature', 'policy_ack', 'start_note'] });
    expect(h.repo.createDraft).not.toHaveBeenCalled();
  });

  it('self mode: the inline fields of the one signing role arrive at their positions', async () => {
    const one: SignTemplateRenderResponse = {
      ...RENDERED,
      signature_fields: [],
      signing: { ...SIGNING, roles: [SIGNING.roles[0]!] },
    };
    const h = harness(one);
    await h.svc.createEnvelope(a, { template_id: TEMPLATE, mode: 'self' }, 'r');
    const body = (h.envelopes.replaceFields.mock.calls[0] as unknown[])[2] as { fields: Array<Record<string, unknown>> };
    expect(body.fields.map((f) => [f['field_key'], f['page_number'], f['x'], f['y']])).toEqual([
      ['employee_signature', 0, 120.5, 600],
      ['policy_ack', 1, 300, 400],
      ['start_note', 1, 80, 300],
    ]);
  });
});
