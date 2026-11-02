import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import {
  DocumentTypeConflictError,
  DocumentTypeNotFoundError,
  OFFER_LETTER_TYPE_ID,
  RIGHT_TO_REPRESENT_TYPE_ID,
  documentTypeKeyFromName,
  type PlatformDocumentTypesRepository,
  type TemplateAuditPort,
} from '@aramo/documents';
import { describe, expect, it, vi } from 'vitest';

import { PlatformDocumentTypesController } from '../document-templates-platform/platform-document-types.controller.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4.3 — the Platform Admin
// document type routes: guards + per-route platform scopes, the consumer_type=platform
// tripwire, shape validation, the GLOBAL audit event written before each change, the
// System / Seeded badges and editable fields (§4.2), and the error mapping.

const READ = 'platform:document_template:read';
const MANAGE = 'platform:document_template:manage';
const RID = 'req-1';
const NEW_ID = '33333333-3333-4333-8333-333333333333';

const ROUTE_SCOPES: Record<string, string> = { list: READ, create: MANAGE, update: MANAGE, retire: MANAGE, remove: MANAGE };

function auth(consumer_type: string): AuthContextType {
  return {
    sub: '01900000-0000-7000-8000-0000000ac001',
    consumer_type: consumer_type as AuthContextType['consumer_type'],
    actor_kind: 'user' as AuthContextType['actor_kind'],
    tenant_id: '01900000-0000-7000-8000-000000000100',
    scopes: [READ, MANAGE],
    iat: 0,
    exp: 0,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: NEW_ID,
    key: 'MUTUAL_NDA',
    name: 'Mutual NDA',
    description: null,
    scope: 'SYSTEM',
    type_class: 'TEMPLATE',
    template_kind: 'EDITABLE',
    products: ['sign'],
    category: 'Legal',
    retention_class: 'CONTRACT_RECORD',
    execution_mode_default: 'MULTI_SIGNATURE',
    system_defined: false,
    active: true,
    created_at: new Date('2026-11-02T00:00:00.000Z'),
    updated_at: new Date('2026-11-02T00:00:00.000Z'),
    ...over,
  };
}

const RTR = row({ id: RIGHT_TO_REPRESENT_TYPE_ID, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', system_defined: true, products: ['ats', 'sign'], category: 'Recruiting' });
const OFFER = row({ id: OFFER_LETTER_TYPE_ID, key: 'OFFER_LETTER', name: 'Offer Letter', system_defined: true, template_kind: null, products: [], category: null });
const I9 = row({ id: '44444444-4444-4444-8444-444444444444', key: 'I9', name: 'I-9', system_defined: true, template_kind: null, products: [], category: null });
const TALENT = row({ id: '01900000-0000-7000-8000-0000000002d1', key: 'TALENT_RESUME', name: 'Talent Resume', type_class: 'UPLOAD', system_defined: true, template_kind: null, products: [], category: null, retention_class: 'TALENT_DOCUMENT' });

function build() {
  const types = {
    listWithUsage: vi.fn(async () => [
      { ...RTR, templates_count: 3, live_default: true },
      { ...OFFER, templates_count: 0, live_default: false },
      { ...I9, templates_count: 0, live_default: false },
      { ...TALENT, templates_count: 0, live_default: false },
    ]),
    listRetentionClasses: vi.fn(async () => ['CONTRACT_RECORD', 'TALENT_DOCUMENT']),
    create: vi.fn(async (i: Record<string, unknown>, before?: (p: unknown) => Promise<void>) => {
      await before?.({ id: NEW_ID, key: i['key'], name: i['name'] });
      return row({ ...i, id: NEW_ID });
    }),
    update: vi.fn(async (id: string, _p: unknown, before?: (p: unknown) => Promise<void>) => {
      await before?.({ type: row({ id }), changed_fields: ['name'] });
      return { type: row({ id }), changed_fields: ['name'] };
    }),
    retire: vi.fn(async (id: string, before?: (p: unknown) => Promise<void>) => {
      await before?.({ type: row({ id }) });
      return row({ id, active: false });
    }),
    delete: vi.fn(async (id: string, before?: (p: unknown) => Promise<void>) => {
      await before?.({ type: row({ id }) });
    }),
  };
  const audit = {
    recordDraftDiscarded: vi.fn(async () => undefined),
    recordPlatformWithdrawal: vi.fn(async () => undefined),
    recordPlatformDeletion: vi.fn(async () => undefined),
    recordPlatformDocumentType: vi.fn(async () => undefined),
    recordGovernance: vi.fn(async () => undefined),
  };
  const c = new PlatformDocumentTypesController(types as unknown as PlatformDocumentTypesRepository, audit as unknown as TemplateAuditPort);
  return { c, types, audit };
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; statusCode?: number; context?: { details?: Record<string, unknown> } }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; statusCode?: number };
  }
  return { code: 'NO_THROW' };
}

const VALID = { name: 'Mutual NDA', template_kind: 'EDITABLE', products: ['sign'], retention_class: 'CONTRACT_RECORD', execution_mode_default: 'MULTI_SIGNATURE', category: 'Legal' };

describe('PlatformDocumentTypesController — authorization surface', () => {
  it('class guards are JwtAuthGuard + RolesGuard; reads need :read, writes :manage', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformDocumentTypesController)).toEqual([JwtAuthGuard, RolesGuard]);
    for (const [name, scope] of Object.entries(ROUTE_SCOPES)) {
      const handler = (PlatformDocumentTypesController.prototype as unknown as Record<string, object>)[name];
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler as object), name).toEqual([scope]);
    }
  });

  it('a tenant token is refused on every route before any repository call', async () => {
    const { c, types } = build();
    const t = auth('tenant');
    for (const p of [c.list(t, RID), c.create(VALID, t, RID), c.update(NEW_ID, { name: 'x' }, t, RID), c.retire(NEW_ID, t, RID), c.remove(NEW_ID, t, RID)]) {
      expect((await errorOf(p)).code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    for (const fn of Object.values(types)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('PlatformDocumentTypesController — behaviour', () => {
  it('list: both classes with badges, editable fields and usage; the retention / signing choices', async () => {
    const { c } = build();
    const r = await c.list(auth('platform'), RID);
    const by = new Map(r.document_types.map((t) => [t.key, t]));
    expect(by.get('RIGHT_TO_REPRESENT')).toMatchObject({ badge: 'SYSTEM', editable_fields: ['name', 'description', 'category', 'products'], templates_count: 3, live_default: true });
    expect(by.get('OFFER_LETTER')).toMatchObject({ badge: 'SYSTEM', editable_fields: ['description'] });
    expect(by.get('I9')).toMatchObject({ badge: 'SEEDED', editable_fields: ['name', 'description', 'category', 'template_kind', 'products', 'retention_class', 'execution_mode_default'] });
    expect(by.get('TALENT_RESUME')).toMatchObject({ type_class: 'UPLOAD', editable_fields: [] });
    expect(r.retention_classes).toEqual(['CONTRACT_RECORD', 'TALENT_DOCUMENT']);
    expect(r.execution_modes).toEqual(['NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE']);
  });

  it('create: key from the name, products ⊆ ats/sign (≥1), kind / signing / retention validated; audit before the write', async () => {
    const { c, types, audit } = build();
    const v = await c.create({ ...VALID, name: '  Mutual NDA (2026) ', products: ['sign', 'ats', 'sign'] }, auth('platform'), RID);
    expect(types.create).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'MUTUAL_NDA_2026', name: 'Mutual NDA (2026)', products: ['ats', 'sign'], template_kind: 'EDITABLE', category: 'Legal' }),
      expect.any(Function),
    );
    expect(audit.recordPlatformDocumentType).toHaveBeenCalledWith({ action: 'created', actor_id: auth('platform').sub, document_type_id: NEW_ID, key: 'MUTUAL_NDA_2026', name: 'Mutual NDA (2026)', requestId: RID });
    expect(v).toMatchObject({ badge: null, templates_count: 0 });
    for (const [body, reason] of [
      [{ ...VALID, products: [] }, 'products_required'],
      [{ ...VALID, products: ['ATS'] }, 'invalid_product'],
      [{ ...VALID, template_kind: 'HYBRID' }, 'invalid_template_kind'],
      [{ ...VALID, execution_mode_default: 'WET_INK' }, 'invalid_execution_mode'],
      [{ ...VALID, retention_class: 'FOREVER' }, 'invalid_retention_class'],
      [{ ...VALID, name: '!!!' }, 'name_invalid'],
    ] as const) {
      expect((await errorOf(c.create(body, auth('platform'), RID))).context?.details?.['reason'], reason).toBe(reason);
    }
  });

  it('update / retire / delete: audited before the change; conflicts map to 409 DOCUMENT_TYPE_CONFLICT; unknown → 404', async () => {
    const { c, types, audit } = build();
    await c.update(NEW_ID, { name: 'Renamed', products: ['sign'] }, auth('platform'), RID);
    expect(types.update).toHaveBeenCalledWith(NEW_ID, { name: 'Renamed', products: ['sign'] }, expect.any(Function));
    expect(audit.recordPlatformDocumentType).toHaveBeenCalledWith(expect.objectContaining({ action: 'updated', changed_fields: ['name'] }));
    await expect(c.retire(NEW_ID, auth('platform'), RID)).resolves.toMatchObject({ active: false });
    expect(audit.recordPlatformDocumentType).toHaveBeenCalledWith(expect.objectContaining({ action: 'retired', document_type_id: NEW_ID }));
    await c.remove(NEW_ID, auth('platform'), RID);
    expect(audit.recordPlatformDocumentType).toHaveBeenCalledWith(expect.objectContaining({ action: 'deleted', document_type_id: NEW_ID }));

    types.retire.mockRejectedValueOnce(new DocumentTypeConflictError(NEW_ID, 'live_default', { live_template_id: 't' }));
    const conflict = await errorOf(c.retire(NEW_ID, auth('platform'), RID));
    expect(conflict).toMatchObject({ code: 'DOCUMENT_TYPE_CONFLICT', statusCode: 409 });
    expect(conflict.context?.details?.['reason']).toBe('live_default');
    types.delete.mockRejectedValueOnce(new DocumentTypeNotFoundError(NEW_ID));
    expect(await errorOf(c.remove(NEW_ID, auth('platform'), RID))).toMatchObject({ code: 'DOCUMENT_TYPE_NOT_FOUND', statusCode: 404 });
    expect((await errorOf(c.update(NEW_ID, {}, auth('platform'), RID))).context?.details?.['reason']).toBe('empty_patch');
  });

  it('no audit port: every write is refused 500 before the repository', async () => {
    const { types } = build();
    const bare = new PlatformDocumentTypesController(types as unknown as PlatformDocumentTypesRepository);
    expect((await errorOf(bare.create(VALID, auth('platform'), RID))).statusCode).toBe(500);
    expect((await errorOf(bare.retire(NEW_ID, auth('platform'), RID))).statusCode).toBe(500);
    expect(types.create).not.toHaveBeenCalled();
    expect(types.retire).not.toHaveBeenCalled();
  });
});

describe('documentTypeKeyFromName', () => {
  it('upper snake ASCII, ≤64 chars', () => {
    expect(documentTypeKeyFromName('Residential lease — Québec')).toBe('RESIDENTIAL_LEASE_QUEBEC');
    expect(documentTypeKeyFromName('W-4')).toBe('W_4');
    expect(documentTypeKeyFromName('***')).toBe('');
    expect(documentTypeKeyFromName('a'.repeat(80)).length).toBe(64);
  });
});
