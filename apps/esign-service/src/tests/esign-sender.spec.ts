import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AramoError } from '@aramo/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { EsignSenderController } from '../app/sender/esign-sender.controller.js';
import { SenderContextService, tenantHostBase } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// PX-1 — the authenticated sender zone. Guard metadata per route (the boundary
// cannot be silently dropped or widened), the backend workspace + Personal rule
// (Lead Host & Workspace Ruling v1.0), and fail-closed input validation.

const READ = ['context', 'summary', 'list', 'detail', 'events', 'source', 'executed', 'evidence', 'documents', 'contacts', 'activity'] as const;
const CREATE = ['create', 'update', 'upload', 'reorder', 'rename', 'remove', 'recipients', 'fields'] as const;
const SEND = ['send', 'remind', 'void'] as const;

const handler = (name: string): object => (EsignSenderController.prototype as unknown as Record<string, object>)[name] ?? {};

describe('EsignSenderController — every route mounts the sender boundary', () => {
  it.each([...READ, ...CREATE, ...SEND])('%s: JwtAuthGuard → esign consumer → entitlement → roles, capability esign', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([JwtAuthGuard, EsignSenderConsumerGuard, EntitlementGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, handler(name))).toEqual(['esign']);
  });
  it.each(READ)('%s requires esign:envelope:read', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['esign:envelope:read']);
  });
  it.each(CREATE)('%s requires esign:envelope:create', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['esign:envelope:create']);
  });
  it.each(SEND)('%s requires esign:envelope:send', (name) => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler(name))).toEqual(['esign:envelope:send']);
  });
  it('covers every route handler on the controller', () => {
    const own = Object.getOwnPropertyNames(EsignSenderController.prototype).filter((n) => n !== 'constructor' && n !== 'run');
    expect(own.sort()).toEqual([...READ, ...CREATE, ...SEND].sort());
  });
});

const AUTH: AuthContextType = {
  sub: '11111111-1111-7111-8111-111111111111',
  consumer_type: 'esign',
  actor_kind: 'user',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  scopes: ['esign:envelope:read', 'esign:envelope:create', 'esign:envelope:send'],
  iat: 0,
  exp: 0,
};

function contextService(kind: string, slug: string | null = 'astre') {
  const tenants = {
    findById: vi.fn(async () => ({ id: AUTH.tenant_id, name: 'Astre', kind, is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => slug),
  };
  const identity = { findUserById: vi.fn(async () => ({ id: AUTH.sub, email: 'p@astre.test', display_name: 'Priya Nair' })) };
  return new SenderContextService(tenants as never, identity as never);
}

describe('SenderContextService — workspace and Personal rule from the backend tenant kind', () => {
  it('BUSINESS → sign workspace; can_send needs create + send', async () => {
    const view = await contextService('BUSINESS').context(AUTH, 'r');
    expect(view).toMatchObject({ workspace: 'sign', can_send: true, personal_sending_enabled: false, tenant: { kind: 'BUSINESS' } });
    expect(view.organization_url).toBe('https://astre.aramo.ai/org/profile');
    const viewer = await contextService('BUSINESS').context({ ...AUTH, scopes: ['esign:envelope:read'] }, 'r');
    expect(viewer).toMatchObject({ can_send: false, permissions: { read: true, create: false, send: false } });
  });

  it('PERSONAL → personal workspace; never can_send, even with every scope; no organization link', async () => {
    const view = await contextService('PERSONAL').context(AUTH, 'r');
    expect(view).toMatchObject({ workspace: 'personal', can_send: false, organization_url: null });
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
    expect(tenantHostBase('astre', { ESIGN_TENANT_HOST_URL_TEMPLATE: 'http://localhost:4205/' })).toBe('http://localhost:4205');
    expect(tenantHostBase(null, {})).toBeNull();
  });
});

function envelopeService(kind = 'BUSINESS') {
  const ctx = contextService(kind);
  const repo = {
    replaceDraftRecipients: vi.fn(async () => []),
    replaceDraftFields: vi.fn(async () => 0),
    createDraft: vi.fn(async () => ({ id: 'e1', status: 'DRAFT', subject: 'Untitled envelope' })),
    getEnvelopeDetail: vi.fn(async () => ({
      id: 'e1', subject: 'S', status: 'DRAFT', created_by: AUTH.sub, created_at: new Date(), sent_at: null, completed_at: null,
      declined_at: null, voided_at: null, documents: [], signers: [],
    })),
    getDocument: vi.fn(async () => ({ source_mode: 'OWNED', document_ref: null, document_revision_ref: null, source_object_key: 'k' })),
  };
  const provider = { voidEnvelope: vi.fn(), sendEnvelope: vi.fn() };
  const identity = { findUserById: vi.fn(async () => null) };
  const storage = { putOwnedSource: vi.fn() };
  const sources = { getSourcePdf: vi.fn() };
  const svc = new SenderEnvelopeService(repo as never, provider as never, ctx, identity as never, storage as never, sources as never);
  return { svc, repo, provider, sources };
}

describe('SenderEnvelopeService — authoring validation fails closed', () => {
  it('PERSONAL tenant: create is refused before any write', async () => {
    const { svc, repo } = envelopeService('PERSONAL');
    await expect(svc.create(AUTH, {}, 'r')).rejects.toBeInstanceOf(AramoError);
    expect(repo.createDraft).not.toHaveBeenCalled();
  });

  it('recipients: name and valid email required; V1 allows exactly one signer (PX-V1 §15)', async () => {
    const { svc, repo } = envelopeService();
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: '', email: 'a@x.test' }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'A', email: 'nope' }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'A', email: 'a@x.test' }, { name: 'B', email: 'b@x.test' }] }, 'r'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'v1_single_signer' } } });
    expect(repo.replaceDraftRecipients).not.toHaveBeenCalled();
    await svc.replaceRecipients(AUTH, 'e1', { recipients: [{ name: 'A', email: 'a@x.test' }] }, 'r');
    expect(repo.replaceDraftRecipients).toHaveBeenCalledTimes(1);
  });

  it('fields: unknown type, negative page, non-positive size and out-of-page boxes are refused', async () => {
    const { svc, repo, sources } = envelopeService();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    sources.getSourcePdf.mockResolvedValue(await pdf.save());
    const base = { envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 72, width: 200, height: 40 };
    for (const bad of [{ field_type: 'STAMP' }, { field_type: 'CHECKBOX' }, { field_type: 'SIGNER_NAME' }, { page_number: -1 }, { width: 0 }, { x: 500 }, { page_number: 1 }]) {
      await expect(svc.replaceFields(AUTH, 'e1', { fields: [{ ...base, ...bad }] }, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(repo.replaceDraftFields).not.toHaveBeenCalled();
    await svc.replaceFields(AUTH, 'e1', { fields: [base] }, 'r');
    expect(repo.replaceDraftFields).toHaveBeenCalledTimes(1);
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
