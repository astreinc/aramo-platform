import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AramoError, AramoExceptionFilter } from '@aramo/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { SenderFieldPassthroughRefusedError } from '@aramo/sign';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { EsignSenderController } from '../app/sender/esign-sender.controller.js';
import { SenderContextService, personalWorkspaceLabel, tenantHostBase } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// PX-1 — the authenticated sender zone. Guard metadata per route (the boundary
// cannot be silently dropped or widened), the backend workspace + Personal rule
// (Lead Host & Workspace Ruling v1.0), and fail-closed input validation.

// M-A12 W1-C.2 — Find in document (textLayerOf) has the source route's read scope.
// M-A14 R-3 — Auto suggest fields (fieldSuggestionsOf) has the text-layer route's read scope.
const READ = ['context', 'summary', 'list', 'detail', 'events', 'source', 'textLayerOf', 'fieldSuggestionsOf', 'executed', 'evidence', 'documents', 'activity'] as const;
// Sign Unified Product S-1 — contacts and member administration carry their own Sign permissions.
const CONTACTS = ['contacts'] as const;
// ORG-UX-1 §6 — the Sign member routes are retired (no MEMBERS group).
// Sign Mobile M-A3 §5 — contact writes (private per owner) need sign:envelope:create.
// Sign Mobile D-W6-3 — deleting a draft is a draft write (sign:envelope:create).
const CREATE = ['create', 'update', 'upload', 'reorder', 'rename', 'remove', 'recipients', 'fields', 'createContact', 'updateContact', 'deleteContact', 'deleteDraft'] as const;
// M-A5 §3.2 / §4.2 — hosted and self-sign sessions need sign:envelope:send.
const SEND = ['send', 'remind', 'void', 'hostedSession', 'selfSignSession'] as const;

const handler = (name: string): object => (EsignSenderController.prototype as unknown as Record<string, object>)[name] ?? {};

describe('EsignSenderController — every route mounts the sender boundary', () => {
  it.each([...READ, ...CREATE, ...SEND, ...CONTACTS])('%s: JwtAuthGuard → esign consumer → entitlement → roles, capability esign', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, handler(name))).toEqual(['sign']);
  });
  it.each(READ)('%s requires sign:envelope:read', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['sign:envelope:read']);
  });
  it.each(CREATE)('%s requires sign:envelope:create', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['sign:envelope:create']);
  });
  it.each(SEND)('%s requires sign:envelope:send', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['sign:envelope:send']);
  });
  it('contacts requires sign:contact:read', () => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler('contacts'))).toEqual(['sign:contact:read']);
  });
  it('covers every route handler on the controller', () => {
    const own = Object.getOwnPropertyNames(EsignSenderController.prototype).filter((n) => n !== 'constructor' && n !== 'run' && n !== 'withEtag');
    expect(own.sort()).toEqual([...READ, ...CREATE, ...SEND, ...CONTACTS].sort());
  });
});

const AUTH: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'sign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
  iat: 0,
  exp: 0,
};

function contextService(kind: string, slug: string | null = 'astre') {
  const tenants = {
    findById: vi.fn(async () => ({ id: AUTH.tenant_id, name: 'Astre', kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => slug),
    findOrganizationNameById: vi.fn(async () => 'Astre Consulting Services Inc'),
  };
  const identity = {
    findUserById: vi.fn(async () => ({ id: AUTH.sub, email: 'p@astre.test', display_name: 'Priya Nair' })),
    // ORG-UX-1 §6 — role-based org_admin.
    findMembership: vi.fn(async () => ({ id: 'm1', is_active: true })),
    findRoleKeysForMembership: vi.fn(async () => ['sign_sender', 'tenant_admin']),
  };
  return new SenderContextService(tenants as never, identity as never);
}

describe('SenderContextService — workspace and Personal rule from the backend tenant kind', () => {
  it('BUSINESS → sign workspace; can_send needs create + send', async () => {
    const view = await contextService('BUSINESS').context(AUTH, 'r');
    expect(view).toMatchObject({ workspace: 'sign', can_send: true, personal_sending_enabled: false, tenant: { kind: 'BUSINESS' } });
    // The organization's display (or legal) name, as the ATS shows it — never the short tenant handle.
    expect(view.tenant.name).toBe('Astre Consulting Services Inc');
    expect(view.organization_url).toBe('https://astre.aramo.ai/org/profile');
    // ORG-UX-1 §6 — org_admin is ROLE-based (tenant_admin here); roles link → /org/roles.
    expect(view.org_admin).toBe(true);
    expect(view.organization_roles_url).toBe('https://astre.aramo.ai/org/roles');
    const viewer = await contextService('BUSINESS').context({ ...AUTH, scopes: ['sign:envelope:read'] }, 'r');
    expect(viewer).toMatchObject({ can_send: false, permissions: { read: true, create: false, send: false, read_all: false, members: false } });
  });

  it('PERSONAL → personal workspace; never can_send, even with every scope; no organization link', async () => {
    const view = await contextService('PERSONAL').context(AUTH, 'r');
    expect(view).toMatchObject({ workspace: 'personal', can_send: false, organization_url: null, org_admin: false, organization_roles_url: null });
  });

  it('PERSONAL → the workspace is labelled with the owner\'s own name, never the stored handle (display only)', async () => {
    const svc = contextService('PERSONAL');
    const tenants = (svc as unknown as { tenants: { findById: ReturnType<typeof vi.fn>; findOrganizationNameById: ReturnType<typeof vi.fn> } }).tenants;
    tenants.findById.mockResolvedValue({ id: AUTH.tenant_id, name: 'Priya Nair (Personal 88df9551)', kind: 'PERSONAL', is_active: true, status: 'ACTIVE' });
    tenants.findOrganizationNameById.mockResolvedValue('Priya Nair (Personal 88df9551)');
    const view = await svc.context(AUTH, 'r');
    expect(view.tenant).toEqual({ id: AUTH.tenant_id, name: 'Priya Nair — Personal', kind: 'PERSONAL' });
    expect(view.tenant.name).not.toMatch(/88df9551/);
    expect(personalWorkspaceLabel(null)).toBe('Personal');
    expect(personalWorkspaceLabel('   ')).toBe('Personal');
    expect(personalWorkspaceLabel(' Jane Doe ')).toBe('Jane Doe — Personal');
  });

  // Aramo-Sign-Mobile-Amendment-M-A8 §2.1 — only the tenant_owner of a PERSONAL tenant is a
  // Personal account owner; everyone else (incl. a Business tenant_owner) is a Business user.
  it.each([
    ['PERSONAL', ['tenant_owner'], true],
    ['PERSONAL', ['sign_sender'], false],
    ['BUSINESS', ['tenant_owner'], false],
    ['BUSINESS', ['sign_sender', 'tenant_admin'], false],
  ] as const)('%s with %j → personal_account_owner %s', async (kind, roles, owner) => {
    const svc = contextService(kind);
    (svc as unknown as { identity: { findRoleKeysForMembership: ReturnType<typeof vi.fn> } }).identity.findRoleKeysForMembership.mockResolvedValue([...roles]);
    expect((await svc.context(AUTH, 'r')).personal_account_owner).toBe(owner);
  });

  it('assertCanAuthor refuses a PERSONAL tenant with personal_sending_not_enabled', async () => {
    await expect(contextService('PERSONAL').assertCanAuthor(AUTH, 'r')).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'personal_sending_not_enabled' } },
    });
    await expect(contextService('BUSINESS').assertCanAuthor(AUTH, 'r')).resolves.toBeUndefined();
  });

  it('tenantHostBase: template with {slug}, fixed local base, and null without a slug', () => {
    expect(tenantHostBase('astre', {})).toBe('https://astre.aramo.ai');
    expect(tenantHostBase('astre', { SIGN_TENANT_HOST_URL_TEMPLATE: 'http://localhost:4205/' })).toBe('http://localhost:4205');
    expect(tenantHostBase(null, {})).toBeNull();
  });
});

function envelopeService(kind = 'BUSINESS') {
  const ctx = contextService(kind);
  const repo = {
    replaceDraftRecipients: vi.fn(async () => []),
    updateDraft: vi.fn(async () => undefined),
    replaceDraftFields: vi.fn(async () => 0),
    createDraft: vi.fn(async () => ({ id: 'e1', status: 'DRAFT', subject: 'Untitled envelope' })),
    getEnvelopeDetail: vi.fn(async () => ({ source_application: 'aramo-sign',
      id: 'e1', subject: 'S', status: 'DRAFT', created_by: AUTH.sub, created_at: new Date(), sent_at: null, completed_at: null,
      declined_at: null, voided_at: null, documents: [], signers: [],
    })),
    getDocument: vi.fn(async () => ({ source_mode: 'OWNED', document_ref: null, document_revision_ref: null, source_object_key: 'k' })),
  };
  const provider = { voidEnvelope: vi.fn(), sendEnvelope: vi.fn() };
  const identity = { findUserById: vi.fn(async () => null), findMembership: vi.fn(async () => null), findRoleKeysForMembership: vi.fn(async () => []) };
  const storage = { putOwnedSource: vi.fn() };
  const sources = { getSourcePdf: vi.fn() };
  const storageGate = { reserveUpload: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const svc = new SenderEnvelopeService(repo as never, provider as never, ctx, identity as never, storage as never, sources as never, storageGate as never);
  return { svc, repo, provider, sources };
}

describe('SenderEnvelopeService — authoring validation fails closed', () => {
  it('PERSONAL tenant: create is refused before any write', async () => {
    const { svc, repo } = envelopeService('PERSONAL');
    await expect(svc.create(AUTH, {}, 'r')).rejects.toBeInstanceOf(AramoError);
    expect(repo.createDraft).not.toHaveBeenCalled();
  });

  it('recipients: name and valid email required; 1 to 10 signers (Multi-Signer M-2); a repeated email is refused before any write', async () => {
    const { svc, repo } = envelopeService();
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: '', email: 'a@x.test' }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'A', email: 'nope' }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}`, email: `s${i + 1}@x.test` }));
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: many(11) }, 'r')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'too_many_signers', max: 10 } },
    });
    await expect(
      svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'A', email: 'a@x.test' }, { name: 'B', email: 'A@X.test' }] }, 'r'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { index: 1, field: 'email' } } });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
    for (const n of [1, 2, 10]) await svc.replaceRecipients(AUTH, 'e1', { recipients: many(n) }, 'r');
    expect(repo.replaceDraftRecipients).toHaveBeenCalledTimes(3);
  });

  it('routing: PARALLEL or SEQUENTIAL only; set with or without a subject', async () => {
    const { svc, repo } = envelopeService();
    await expect(svc.update(AUTH, 'e1', { routing_mode: 'RANDOM' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { field: 'routing_mode' } } });
    await expect(svc.update(AUTH, 'e1', {}, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await svc.update(AUTH, 'e1', { routing_mode: 'SEQUENTIAL' }, 'r');
    expect(repo.updateDraft).toHaveBeenLastCalledWith({ tenant_id: AUTH.tenant_id, envelope_id: 'e1', routing_mode: 'SEQUENTIAL' });
  });

  it('fields: unknown type, negative page, non-positive size and out-of-page boxes are refused', async () => {
    const { svc, repo, sources } = envelopeService();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    sources.getSourcePdf.mockResolvedValue(await pdf.save());
    const base = { envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 72, width: 200, height: 40 };
    // M-A6 §2.1 — SIGNER_NAME and CHECKBOX are authorable. FIELD-PARITY-1 P3 — ACKNOWLEDGEMENT too (R-2).
    for (const bad of [{ field_type: 'STAMP' }, { page_number: -1 }, { width: 0 }, { x: 500 }, { page_number: 1 }]) {
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...base, ...bad }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...base, field_type: 'STAMP' }] }, 'r')).rejects.toMatchObject({
      // M-A12 W1-C.4 — + the profile text fields; FIELD-PARITY-1 P3 — + ACKNOWLEDGEMENT and the new types.
      context: {
        details: {
          reason: 'v1_field_type',
          allowed: ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE', 'ACKNOWLEDGEMENT', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'],
        },
      },
    });
    expect(repo.replaceDraftFields).not.toHaveBeenCalled();
    await svc.replaceFields(AUTH, 'e1', { fields: [base] }, 'r');
    expect(repo.replaceDraftFields).toHaveBeenCalledTimes(1);
    await svc.replaceFields(AUTH, 'e1', { fields: [{ ...base, field_type: 'CHECKBOX', width: 14, height: 14 }, { ...base, field_type: 'SIGNER_NAME' }] }, 'r');
    expect(repo.replaceDraftFields).toHaveBeenCalledTimes(2);
  });

  // M-A6 §2.2/§2.3 — Name and Checkbox configuration on PUT fields.
  describe('Name and Checkbox configuration (M-A6 §2)', () => {
    const setup = async () => {
      const ctx = envelopeService();
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      ctx.sources.getSourcePdf.mockResolvedValue(await pdf.save());
      return ctx;
    };
    const box = { envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 0, x: 72, y: 72, width: 14, height: 14 };
    const name = { ...box, field_type: 'SIGNER_NAME', width: 200, height: 24 };
    const stored = (repo: { replaceDraftFields: { mock: { calls: unknown[][] } } }) =>
      (repo.replaceDraftFields.mock.calls.at(-1)?.[0] as { fields: Array<Record<string, unknown>> }).fields;

    it('SIGNER_NAME defaults to SIGNER_PROFILE and accepts SIGNER_ENTERED', async () => {
      const { svc, repo } = await setup();
      await svc.replaceFields(AUTH, 'e1', { fields: [name, { ...name, y: 200, name_mode: 'SIGNER_ENTERED' }] }, 'r');
      expect(stored(repo).map((f) => f['name_mode'])).toEqual(['SIGNER_PROFILE', 'SIGNER_ENTERED']);
    });

    it('a sender value is refused for every type, including a name', async () => {
      const { svc, repo } = await setup();
      for (const f of [{ ...name, value: 'Mallory' }, { ...box, value: 'true' }]) {
        await expect(svc.replaceFields(AUTH, 'e1', { fields: [f] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'sender_value_refused', field: 'value' } } });
      }
      expect(repo.replaceDraftFields).not.toHaveBeenCalled();
    });

    it('refuses an unknown name_mode and configuration on the wrong type', async () => {
      const { svc } = await setup();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...name, name_mode: 'SENDER' }, 'name_mode_invalid'],
        [{ ...box, name_mode: 'SIGNER_PROFILE' }, 'field_config_not_applicable'],
        [{ ...name, validation: 'email' }, 'field_config_not_applicable'],
        [{ ...box, field_type: 'TEXT', width: 100, group_key: 'g' }, 'field_config_not_applicable'],
        [{ ...box, group_rule: 'SELECT_ONE' }, 'checkbox_group_required'],
        [{ ...box, min_selected: 2 }, 'checkbox_group_required'],
        [{ ...box, group_key: 'g', group_rule: 'SOME' }, 'checkbox_group_invalid'],
        [{ ...box, group_key: 'g', group_rule: 'SELECT_ONE', min_selected: 2 }, 'checkbox_group_invalid'],
        [{ ...box, group_key: 'g', min_selected: 0 }, 'checkbox_group_invalid'],
        [{ ...box, label: 'x'.repeat(201) }, 'checkbox_label_invalid'],
        [{ ...box, group_key: 'g'.repeat(65) }, 'checkbox_group_invalid'],
      ];
      for (const [f, reason] of cases) {
        await expect(svc.replaceFields(AUTH, 'e1', { fields: [f] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason } } });
      }
    });

    it('an engine-only type with an id is handed to the repository as an exact pass-through; the repository refusal maps to v1_field_type', async () => {
      const { svc, repo } = await setup();
      const ack = { id: 'f-ack', envelope_document_id: 'd1', signer_id: null, field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10.123, y: 20.456, width: null, height: null, required: false };
      await svc.replaceFields(AUTH, 'e1', { fields: [ack] }, 'r');
      expect(stored(repo)[0]).toEqual({
        passthrough_id: 'f-ack', envelope_document_id: 'd1', signer_id: null, field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10.123, y: 20.456, width: null, height: null, required: false,
        label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null,
      });
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...ack, value: 'true' }] }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'sender_value_refused' } } });
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...ack, field_type: 'STAMP' }] }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'v1_field_type' } } });
      repo.replaceDraftFields.mockRejectedValueOnce(new SenderFieldPassthroughRefusedError(0));
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [ack] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'v1_field_type', index: 0 } } });
    });

    it('stores a label and group (rule defaults to SELECT_ANY) and refuses inconsistent groups', async () => {
      const { svc, repo } = await setup();
      await svc.replaceFields(AUTH, 'e1', { fields: [{ ...box, label: '  I agree  ' }, { ...box, y: 100, group_key: 'opt' }, { ...box, y: 120, group_key: 'opt' }] }, 'r');
      expect(stored(repo)).toMatchObject([
        { label: 'I agree', group_key: null, group_rule: null, min_selected: null },
        { label: null, group_key: 'opt', group_rule: 'SELECT_ANY', min_selected: null },
        { group_key: 'opt', group_rule: 'SELECT_ANY' },
      ]);
      const inconsistent: Array<Array<Record<string, unknown>>> = [
        [{ ...box, group_key: 'g' }, { ...box, y: 100, group_key: 'g', signer_id: 's2' }],
        [{ ...box, group_key: 'g', group_rule: 'SELECT_ONE' }, { ...box, y: 100, group_key: 'g' }],
        [{ ...box, group_key: 'g' }, { ...box, y: 100, group_key: 'g', required: false }],
        [{ ...box, group_key: 'g', min_selected: 2 }, { ...box, y: 100, group_key: 'g' }],
      ];
      for (const fields of inconsistent) {
        await expect(svc.replaceFields(AUTH, 'e1', { fields }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'checkbox_group_inconsistent', group_key: 'g' } } });
      }
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...box, group_key: 'g', min_selected: 3 }, { ...box, y: 100, group_key: 'g', min_selected: 3 }] }, 'r')).rejects.toMatchObject({
        context: { details: { reason: 'checkbox_group_min_exceeds_size' } },
      });
    });

    // FIELD-PARITY-1 P3 §6 — the new types and settings, through the one settings rule.
    describe('FIELD-PARITY-1 P3 — new types and settings', () => {
      const at = { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 72, y: 72, width: 150, height: 22 };

      it('accepts the new types with their settings and stores them', async () => {
        const { svc, repo } = await setup();
        const fields = [
          { ...at, field_type: 'DATE', label: 'Effective date', validation: 'date_range', options: { min_date: '2026-01-01' }, data_name: 'effective', font_size: 9 },
          { ...at, y: 110, field_type: 'DROPDOWN', options: { choices: ['a', { value: 'b', label: 'Bee' }] }, placeholder: 'Choose', tooltip: 'Pick one' },
          { ...at, y: 150, width: 14, height: 14, field_type: 'RADIO', label: 'Yes', group_key: 'vote', required: false },
          { ...at, y: 170, width: 14, height: 14, field_type: 'RADIO', label: 'No', group_key: 'vote', required: false },
          { ...at, y: 200, field_type: 'NUMBER', options: { format: 'money' } },
          { ...at, y: 240, field_type: 'MULTILINE_TEXT', height: 60, validation: 'max_length', options: { max_length: 300 } },
          { ...at, y: 320, field_type: 'ACKNOWLEDGEMENT', width: 300, label: 'I have read the policy' },
          { ...at, y: 360, field_type: 'TEXT', label: 'Reference', validation: 'us_zip' },
        ];
        await svc.replaceFields(AUTH, 'e1', { fields }, 'r');
        const s = stored(repo);
        expect(s.map((f) => f['field_type'])).toEqual(['DATE', 'DROPDOWN', 'RADIO', 'RADIO', 'NUMBER', 'MULTILINE_TEXT', 'ACKNOWLEDGEMENT', 'TEXT']);
        expect(s[0]).toMatchObject({ label: 'Effective date', validation: 'date_range', options: { min_date: '2026-01-01' }, data_name: 'effective', font_size: 9, sender_filled: false, read_only: false });
        expect(s[1]).toMatchObject({ options: { choices: [{ value: 'a', label: 'a' }, { value: 'b', label: 'Bee' }] }, placeholder: 'Choose', tooltip: 'Pick one' });
        expect(s[2]).toMatchObject({ group_key: 'vote', group_rule: 'SELECT_ONE', min_selected: null });
        expect(s[4]).toMatchObject({ options: { format: 'money', currency: 'USD', decimals: 2 } });
        expect(s[6]).toMatchObject({ label: 'I have read the policy' });
        expect(s[7]).toMatchObject({ label: 'Reference', validation: 'us_zip' });
        for (const f of s) expect(f).not.toHaveProperty('sender_value');
      });

      it('refuses a broken setting with its named reason', async () => {
        const { svc } = await setup();
        const cases: Array<[Record<string, unknown>, string]> = [
          [{ ...at, field_type: 'DROPDOWN' }, 'dropdown_choices_invalid'],
          [{ ...at, field_type: 'RADIO', width: 14, height: 14 }, 'radio_group_required'],
          [{ ...at, field_type: 'RADIO', width: 14, height: 14, group_key: 'v', group_rule: 'SELECT_ANY' }, 'radio_group_invalid'],
          [{ ...at, field_type: 'NUMBER', options: { currency: 'EUR' } }, 'number_format_invalid'],
          [{ ...at, field_type: 'TEXT', validation: 'number_range' }, 'validation_invalid'],
          [{ ...at, field_type: 'TEXT', font_size: 99 }, 'font_size_invalid'],
          [{ ...at, field_type: 'TEXT', data_name: 'Bad Name' }, 'data_name_invalid'],
          [{ ...at, field_type: 'SIGNATURE', placeholder: 'x' }, 'field_config_not_applicable'],
          [{ ...at, field_type: 'TEXT', read_only: true }, 'read_only_requires_sender_filled'],
        ];
        for (const [f, reason] of cases) {
          await expect(svc.replaceFields(AUTH, 'e1', { fields: [f] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason } } });
        }
      });

      it('S-5 is dark: sender_filled is refused while SIGN_SENDER_FILLED_FIELDS_ENABLED is off; a value stays refused', async () => {
        const { svc, repo } = await setup();
        await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, field_type: 'TEXT', sender_filled: true, value: 'ACME-1' }] }, 'r')).rejects.toMatchObject({
          context: { details: { reason: 'sender_filled_not_available', field: 'sender_filled' } },
        });
        await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, field_type: 'DATE', value: '2026-05-01' }] }, 'r')).rejects.toMatchObject({
          context: { details: { reason: 'sender_value_refused', field: 'value' } },
        });
        expect(repo.replaceDraftFields).not.toHaveBeenCalled();
      });

      it('S-5 with the flag on: the sender value is checked by the value rule and handed to the repository as the sender\'s', async () => {
        vi.stubEnv('SIGN_SENDER_FILLED_FIELDS_ENABLED', '1');
        try {
          const { svc, repo } = await setup();
          await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, field_type: 'DATE', sender_filled: true, value: '2026-02-30' }] }, 'r')).rejects.toMatchObject({
            context: { details: { reason: 'date_value_invalid', field: 'value' } },
          });
          await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, field_type: 'TEXT', value: 'x' }] }, 'r')).rejects.toMatchObject({
            context: { details: { reason: 'sender_value_refused' } },
          });
          const radio = { ...at, width: 14, height: 14, field_type: 'RADIO', group_key: 'v', sender_filled: true, read_only: true };
          await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...radio, value: 'true' }, { ...radio, y: 100, value: 'true' }] }, 'r')).rejects.toMatchObject({
            context: { details: { reason: 'radio_group_select_one' } },
          });
          await svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, field_type: 'NUMBER', sender_filled: true, read_only: true, value: '1250.5', options: { format: 'money' } }, { ...at, y: 150, field_type: 'TEXT', sender_filled: true }] }, 'r');
          const s = stored(repo);
          expect(s[0]).toMatchObject({ sender_filled: true, read_only: true, sender_value: '1250.5' });
          expect(s[1]).toMatchObject({ sender_filled: true, sender_value: null });
          expect((repo.replaceDraftFields.mock.calls.at(-1)?.[0] as { actor_ref?: string }).actor_ref).toBe(AUTH.sub);
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it('readiness: a required sender-filled field needs the sender\'s value', () => {
        const { svc } = envelopeService();
        const base = { documents: [{}], recipients: [{ id: 's1', name: 'Alex' }] };
        const sig = { signer_id: 's1', field_type: 'SIGNATURE', required: true };
        expect(svc.readiness({ ...base, fields: [sig, { signer_id: 's1', field_type: 'TEXT', required: true, sender_filled: true, value: null, label: 'Reference' }] } as never)).toEqual({
          ok: false,
          problems: ['Fill in Reference before sending'],
        });
        expect(svc.readiness({ ...base, fields: [sig, { signer_id: 's1', field_type: 'TEXT', required: true, sender_filled: true, value: 'R-1' }] } as never)).toEqual({ ok: true, problems: [] });
      });

      it('a legacy engine ACKNOWLEDGEMENT (no recipient / size) still passes through unchanged; a sender-authored one is a normal field', async () => {
        const { svc, repo } = await setup();
        await svc.replaceFields(AUTH, 'e1', { fields: [{ ...at, id: 'f-ack', field_type: 'ACKNOWLEDGEMENT', width: 300 }] }, 'r');
        expect(stored(repo)[0]).not.toHaveProperty('passthrough_id');
      });
    });
  });

  it('void requires a reason; readiness lists each missing signature field', async () => {
    const { svc, provider } = envelopeService();
    await expect(svc.void(AUTH, 'e1', { reason: '  ' }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(provider.voidEnvelope).not.toHaveBeenCalled();
    const r = svc.readiness({
      documents: [{}],
      recipients: [{ id: 's1', name: 'Alex' }, { id: 's2', name: 'Priya' }],
      fields: [{ signer_id: 's1', field_type: 'SIGNATURE' }, { signer_id: 's2', field_type: 'SIGN_DATE' }],
    } as never);
    expect(r).toEqual({ ok: false, problems: ['Priya needs a signature field'] });
  });
});

describe('EsignSignerController — canonical error envelope for the signer page', () => {
  it('mounts AramoExceptionFilter so invalid / expired links reach their dedicated screens', async () => {
    const { EsignSignerController } = await import('../app/esign-http.controller.js');
    const filters = Reflect.getMetadata('__exceptionFilters__', EsignSignerController) as unknown[];
    expect(filters).toContain(AramoExceptionFilter);
  });
});
