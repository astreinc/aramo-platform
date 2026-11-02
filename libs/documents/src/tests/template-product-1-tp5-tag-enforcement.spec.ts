import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import {
  DocumentTemplateLibraryController,
  DocumentTemplatesController,
  TemplateResolutionService,
  TemplatesRepository,
  entitledTemplateProducts,
  visibleToTenant,
} from '../index.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §6 — tag inheritance and
// enforcement, with pure fakes (no DB). E = the tenant's entitlement capabilities.
//   §6.1 tenant products are server-written (from the type at create, copied at Adopt); no
//        tenant route accepts `products`.
//   §6.3 gallery / default preview / Adopt / withdrawal notices: only defaults whose
//        products ∩ E ≠ ∅; resolution with a product resolves only templates tagged with it.

const AUTH = { tenant_id: 't-1', sub: 'u-1' } as never;
const TYPE = 'aaaaaaaa-0000-4000-8000-000000000001';

function entitlements(caps: string[]) {
  return { getCapabilities: vi.fn(async () => new Set(caps)) } as never;
}

async function codeOf(p: Promise<unknown>): Promise<[string, number]> {
  try {
    await p;
    return ['NO_THROW', 0];
  } catch (e) {
    if (e instanceof AramoError) return [e.code, e.statusCode];
    return [(e as Error).constructor.name, 0];
  }
}

function tpl(over: Record<string, unknown>) {
  return {
    id: 'x',
    tenant_id: null,
    owner_scope: 'PLATFORM',
    document_type_id: TYPE,
    client_id: null,
    name: 'T',
    description: null,
    template_kind: 'GENERATED',
    status: 'ACTIVE',
    current_version_id: 'v-x',
    products: ['ats'],
    withdraw_effective_at: null,
    updated_at: new Date('2026-11-01T00:00:00.000Z'),
    ...over,
  };
}

describe('§6.3 helpers', () => {
  it('entitledTemplateProducts = E ∩ {ats, sign} (canonical order)', () => {
    expect(entitledTemplateProducts(new Set(['core', 'sign', 'ats', 'portal']))).toEqual(['ats', 'sign']);
    expect(entitledTemplateProducts(new Set(['core']))).toEqual([]);
  });

  it('visibleToTenant = products ∩ E ≠ ∅ (case-insensitive)', () => {
    expect(visibleToTenant(['ats', 'sign'], ['sign'])).toBe(true);
    expect(visibleToTenant(['ATS'], ['ats'])).toBe(true);
    expect(visibleToTenant(['ats'], ['sign'])).toBe(false);
    expect(visibleToTenant([], ['ats', 'sign'])).toBe(false);
    expect(visibleToTenant(null, ['ats'])).toBe(false);
  });
});

describe('§6.3 Org gallery GET library + default preview', () => {
  const rows = [
    tpl({ id: 'def-both', products: ['ats', 'sign'], current_version_id: 'v1' }),
    tpl({ id: 'def-ats', products: ['ats'], current_version_id: 'v2' }),
    tpl({ id: 'def-sign', products: ['sign'], current_version_id: 'v3' }),
    tpl({ id: 'own', tenant_id: 't-1', owner_scope: 'TENANT', products: ['ats', 'sign'], current_version_id: 'v4' }),
  ];
  const repo = {
    listTemplatesForTenantIncludingPlatform: vi.fn(async () => rows),
    listVersionSummariesOwnerAware: vi.fn(async () => []),
    listSystemDocumentTypes: vi.fn(async () => [{ id: TYPE, key: 'NDA', name: 'NDA', products: ['ats', 'sign'], category: 'Legal' }]),
    findTemplateByIdOwnerAware: vi.fn(async (_t: string, id: string) => rows.find((r) => r.id === id) ?? null),
  } as unknown as TemplatesRepository;

  function controller(caps: string[]) {
    return new DocumentTemplateLibraryController(repo, undefined, undefined, undefined, entitlements(caps));
  }

  it('a Sign-only tenant sees only the defaults tagged sign; its own templates carry their tags', async () => {
    const out = await controller(['core', 'sign']).library(AUTH);
    expect(out.items.map((i) => i.id)).toEqual(['def-both', 'def-sign', 'own']);
    expect(out.items.find((i) => i.id === 'own')?.products).toEqual(['ats', 'sign']);
    expect(out.entitled_products).toEqual(['sign']);
    expect(out.document_types[0]).toMatchObject({ products: ['ats', 'sign'], category: 'Legal' });
  });

  it('an ATS + Sign tenant sees every default; a core-only tenant sees none', async () => {
    expect((await controller(['core', 'ats', 'sign']).library(AUTH)).items.map((i) => i.id)).toEqual(['def-both', 'def-ats', 'def-sign', 'own']);
    const none = await controller(['core']).library(AUTH);
    expect(none.items.map((i) => i.id)).toEqual(['own']);
    expect(none.entitled_products).toEqual([]);
  });

  it('library/:id/preview of a default for products the tenant has none of is 404', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    rows.push(tpl({ id, products: ['ats'] }));
    expect(await codeOf(controller(['core', 'sign']).previewDefault(AUTH, id, 'r'))).toEqual(['TEMPLATE_NOT_FOUND', 404]);
    rows.pop();
  });
});

describe('§6.1/§6.3 tenant templates routes', () => {
  it('POST /v1/document-templates refuses `products` (server-written) before any write', async () => {
    const createTemplate = vi.fn();
    const c = new DocumentTemplatesController({ createTemplate } as never);
    const body = { document_type_id: TYPE, name: 'Mine', template_kind: 'GENERATED', products: ['sign'] } as never;
    expect(await codeOf(c.create(AUTH, body, 'r'))).toEqual(['VALIDATION_ERROR', 422]);
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('POST /v1/document-templates passes only the known fields (products come from the type in the repository)', async () => {
    const createTemplate = vi.fn(async () => ({ id: 'n', document_type_id: TYPE }));
    const c = new DocumentTemplatesController({ createTemplate } as never);
    await c.create(AUTH, { document_type_id: TYPE, name: 'Mine', template_kind: 'GENERATED' } as never, 'r');
    expect(createTemplate).toHaveBeenCalledWith({ tenant_id: 't-1', created_by: 'u-1', document_type_id: TYPE, name: 'Mine', template_kind: 'GENERATED' });
  });

  it('PATCH /v1/document-templates/:id refuses `products`', async () => {
    const renameTemplate = vi.fn();
    const c = new DocumentTemplatesController({ renameTemplate } as never);
    expect(await codeOf(c.rename(AUTH, 'id', { name: 'x', products: ['ats'] } as never, 'r'))).toEqual(['VALIDATION_ERROR', 422]);
    expect(renameTemplate).not.toHaveBeenCalled();
  });

  it('Adopt: a default for products the tenant has none of is 404; an entitled one is adopted', async () => {
    const source = tpl({ id: 'def', products: ['ats'] });
    const adoptPlatformTemplate = vi.fn(async () => ({ template: { id: 'new', document_type_id: TYPE, adopted_from_template_id: 'def', adopted_from_version_id: 'v' }, version: { field_schema: null } }));
    const repo = { findTemplateByIdOwnerAware: vi.fn(async () => source), adoptPlatformTemplate } as never;
    const signOnly = new DocumentTemplatesController(repo, undefined, undefined, undefined, entitlements(['core', 'sign']));
    expect(await codeOf(signOnly.adopt(AUTH, { library_template_id: 'def' } as never, 'r'))).toEqual(['TEMPLATE_NOT_FOUND', 404]);
    expect(adoptPlatformTemplate).not.toHaveBeenCalled();
    const ats = new DocumentTemplatesController(repo, undefined, undefined, undefined, entitlements(['core', 'ats']));
    expect(await codeOf(ats.adopt(AUTH, { library_template_id: 'def' } as never, 'r'))).toEqual(['NO_THROW', 0]);
    expect(adoptPlatformTemplate).toHaveBeenCalledTimes(1);
  });

  it('withdrawal notices: only for defaults the tenant can see', async () => {
    const at = new Date('2026-11-10T00:00:00.000Z');
    const notice = (template_id: string, products: string[]) => ({
      template_id,
      name: template_id,
      document_type_id: TYPE,
      products,
      withdraw_notice_at: at,
      withdraw_effective_at: at,
      in_effect: false,
      selected_for_client_ids: [null],
      relies_on_default: true,
      has_own_template: false,
    });
    const repo = { listWithdrawalNoticesForTenant: vi.fn(async () => [notice('a', ['ats']), notice('s', ['sign']), notice('b', ['ats', 'sign'])]) } as never;
    const c = new DocumentTemplatesController(repo, undefined, undefined, undefined, entitlements(['core', 'sign']));
    expect((await c.notices(AUTH)).notices.map((n) => n.template_id)).toEqual(['s', 'b']);
  });
});

describe('§6.1 repository — products are server-written', () => {
  it('createTemplate copies the document type products', async () => {
    const create = vi.fn(async (a: unknown) => a);
    const prisma = { documentType: { findFirst: vi.fn(async () => ({ products: ['sign'] })) }, documentTemplate: { create } };
    await new TemplatesRepository(prisma as never).createTemplate({ tenant_id: 't-1', document_type_id: TYPE, name: 'n', template_kind: 'GENERATED', created_by: 'u' });
    expect((create.mock.calls[0]?.[0] as { data: { products: string[] } }).data.products).toEqual(['sign']);
  });
});

describe('§6.3 resolution with a product', () => {
  const TENANT_TPL = tpl({ id: 'own', tenant_id: 't-1', owner_scope: 'TENANT', products: ['ats', 'sign'], current_version_id: 'v-own' });
  const ATS_ONLY = tpl({ id: 'ats-only', tenant_id: 't-1', owner_scope: 'TENANT', products: ['ats'], current_version_id: 'v-ats' });
  function service(selected: Record<string, unknown>, defaults: Array<Record<string, unknown>> = []) {
    const repo = {
      findSelection: vi.fn(async (_t: string, _d: string, client: string | null) => (client === null ? { template_id: selected['id'], legacy_platform: null } : null)),
      findTemplateByIdOwnerAware: vi.fn(async () => selected),
      findVersionByIdOwnerAware: vi.fn(async (_t: string, id: string) => ({ id, template_id: selected['id'], status: 'ACTIVE' })),
      findResolvablePlatformDefaults: vi.fn(async () => defaults),
      listWithdrawnPlatformDefaultIds: vi.fn(async () => []),
      listTenantFallbackTemplates: vi.fn(async () => []),
    } as unknown as TemplatesRepository;
    return new TemplateResolutionService(repo);
  }

  it('a selection tagged with the product resolves (ATS and Sign alike)', async () => {
    expect((await service(TENANT_TPL).resolve({ tenant_id: 't-1', document_type_id: TYPE, product: 'ats' })).outcome).toBe('RESOLVED');
    expect((await service(TENANT_TPL).resolve({ tenant_id: 't-1', document_type_id: TYPE, product: 'sign' })).outcome).toBe('RESOLVED');
  });

  it('a selection not tagged with the product is skipped (NOT_CONFIGURED, or SELECTION_REQUIRED when a tagged default exists)', async () => {
    expect((await service(ATS_ONLY).resolve({ tenant_id: 't-1', document_type_id: TYPE, product: 'sign' })).outcome).toBe('NOT_CONFIGURED');
    expect((await service(ATS_ONLY, [tpl({ id: 'd', products: ['sign'] })]).resolve({ tenant_id: 't-1', document_type_id: TYPE, product: 'sign' })).outcome).toBe(
      'SELECTION_REQUIRED',
    );
    // A default tagged only for another product is not a starting point for this one.
    expect((await service(ATS_ONLY, [tpl({ id: 'd', products: ['ats'] })]).resolve({ tenant_id: 't-1', document_type_id: TYPE, product: 'sign' })).outcome).toBe(
      'NOT_CONFIGURED',
    );
  });

  it('without a product nothing is filtered (unchanged for other callers)', async () => {
    expect((await service(ATS_ONLY).resolve({ tenant_id: 't-1', document_type_id: TYPE })).outcome).toBe('RESOLVED');
  });
});
