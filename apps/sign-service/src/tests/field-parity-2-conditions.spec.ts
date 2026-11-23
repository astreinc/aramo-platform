import 'reflect-metadata';
import type { AuthContextType } from '@aramo/auth';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4 Phase B —
// the sender API's field keys (B-1) and conditions (B-2, B-3, B-10), unit level (the repository
// is a fake; the integration specs cover the database).

const AUTH: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'sign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
  iat: 0,
  exp: 0,
};

function setup(envelope_mode: string | null = null) {
  const tenants = {
    findById: vi.fn(async () => ({ id: AUTH.tenant_id, name: 'Astre', kind: 'BUSINESS', is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre'),
  };
  const identity = {
    findUserById: vi.fn(async () => ({ id: AUTH.sub, email: 'p@astre.test', display_name: 'Priya Nair' })),
    findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })),
    findRoleKeysForMembership: vi.fn(async () => ['sign_sender', 'tenant_admin']),
  };
  const ctx = new SenderContextService(tenants as never, identity as never);
  const repo = {
    replaceDraftFields: vi.fn(async () => 0),
    getEnvelopeDetail: vi.fn(async () => ({
      source_application: 'aramo-sign',
      id: 'e1', subject: 'S', status: 'DRAFT', created_by: AUTH.sub, created_at: new Date(), sent_at: null, completed_at: null,
      declined_at: null, voided_at: null, documents: [], signers: [], envelope_mode,
    })),
    getDocument: vi.fn(async () => ({ source_mode: 'OWNED', document_ref: null, document_revision_ref: null, source_object_key: 'k' })),
  };
  const sources = { getSourcePdf: vi.fn() };
  const svc = new SenderEnvelopeService(repo as never, {} as never, ctx, identity as never, {} as never, sources as never, {} as never);
  const stored = (): Array<Record<string, unknown>> => (repo.replaceDraftFields.mock.calls.at(-1)?.[0] as unknown as { fields: Array<Record<string, unknown>> }).fields;
  return {
    svc,
    repo,
    stored,
    ready: async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      sources.getSourcePdf.mockResolvedValue(await pdf.save());
    },
  };
}

const at = { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 72, y: 72, width: 150, height: 22 };
const sig = { ...at, field_type: 'SIGNATURE', width: 200, height: 40, y: 600 };

describe('FIELD-PARITY-2 B-1 — the field key on PUT …/fields', () => {
  it('stores the editor id as field_key, and none when absent', async () => {
    const { svc, stored, ready } = setup();
    await ready();
    await svc.replaceFields(AUTH, 'e1', { fields: [{ ...sig, field_key: 'sig_1' }, { ...at, field_type: 'TEXT' }] }, 'r');
    expect(stored().map((f) => f['field_key'])).toEqual(['sig_1', null]);
  });

  it('refuses a key used twice (field_key_duplicate) and a key that is not 1 to 200 characters (field_key_invalid)', async () => {
    const { svc, repo, ready } = setup();
    await ready();
    await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...sig, field_key: 'k' }, { ...at, field_type: 'TEXT', field_key: 'k' }] }, 'r')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'field_key_duplicate', field: 'field_key', index: 1 } },
    });
    for (const bad of ['', '   ', 'x'.repeat(201), 7]) {
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...sig, field_key: bad }] }, 'r')).rejects.toMatchObject({
        context: { details: { reason: 'field_key_invalid', field: 'field_key', index: 0 } },
      });
    }
    expect(repo.replaceDraftFields).not.toHaveBeenCalled();
  });
});

describe('FIELD-PARITY-2 B-2 / B-3 — conditions on PUT …/fields (the one cross-field rule)', () => {
  const box = { ...at, field_type: 'CHECKBOX', width: 14, height: 14, field_key: 'agree' };
  const dependent = (condition: unknown, extra: Record<string, unknown> = {}) => ({ ...at, y: 200, field_type: 'TEXT', field_key: 'detail', condition, ...extra });

  it('stores a condition with its trigger key', async () => {
    const { svc, stored, ready } = setup();
    await ready();
    await svc.replaceFields(AUTH, 'e1', { fields: [{ ...sig, field_key: 'sig' }, box, dependent({ trigger_key: 'agree', when: 'checked' })] }, 'r');
    expect(stored()[2]).toMatchObject({ field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } });
    expect(stored()[1]).toMatchObject({ field_key: 'agree', condition: null });
  });

  it('refuses each cross-field problem with its named reason (§4.3), before any write', async () => {
    const { svc, repo, ready } = setup();
    await ready();
    const cases: Array<[Array<Record<string, unknown>>, string]> = [
      [[sig, box, dependent({ trigger_key: 'gone', when: 'checked' })], 'condition_trigger_unknown'],
      [[sig, box, dependent({ trigger_key: 'agree', when: 'one_of', values: ['a'] })], 'condition_trigger_type_invalid'],
      [[sig, box, dependent({ trigger_key: 'agree', when: 'checked' }, { signer_id: 's2' })], 'condition_cross_signer'],
      [[sig, { ...at, field_type: 'DROPDOWN', field_key: 'plan', options: { choices: ['a'] } }, dependent({ trigger_key: 'plan', when: 'one_of', values: ['z'] })], 'condition_values_invalid'],
      [[sig, { ...box, condition: { trigger_key: 'agree2', when: 'checked' } }, { ...box, y: 300, field_key: 'agree2', condition: { trigger_key: 'agree', when: 'checked' } }], 'condition_cycle'],
      [[{ ...sig, condition: { trigger_key: 'agree', when: 'checked' } }, box], 'condition_no_unconditional_signature'],
      [[sig, box, dependent({ trigger_key: 'agree' })], 'condition_invalid'],
    ];
    for (const [fields, reason] of cases) {
      await expect(svc.replaceFields(AUTH, 'e1', { fields }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason } } });
    }
    expect(repo.replaceDraftFields).not.toHaveBeenCalled();
  });

  it('C-6 — readiness counts only signature fields that are always shown', () => {
    const { svc } = setup();
    const base = { documents: [{}], recipients: [{ id: 's1', name: 'Alex' }] };
    const cond = { signer_id: 's1', field_type: 'SIGNATURE', required: true, condition: { trigger_key: 'agree', when: 'checked' } };
    expect(svc.readiness({ ...base, fields: [cond] } as never)).toEqual({ ok: false, problems: ['Alex needs a signature field'] });
    expect(svc.readiness({ ...base, fields: [cond, { signer_id: 's1', field_type: 'SIGNATURE', required: true, condition: null }] } as never)).toEqual({ ok: true, problems: [] });
  });
});
