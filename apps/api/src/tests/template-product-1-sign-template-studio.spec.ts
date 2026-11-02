import { describe, expect, it, vi } from 'vitest';

import { SignTemplateStudioService } from '../documents/sign-template-studio.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Documents side
// of the Sign Studio and "Use as it is" (unit; the HTTP + Postgres proof is
// template-product-1-sign-studio-http.integration.spec.ts):
//   - authority from the person's LIVE grants (author / manage), never a token;
//   - the Studio is PERSONAL-only (BUSINESS 403 organization_templates_in_org_home);
//   - only live Aramo defaults tagged `sign` are offered or adoptable;
//   - "Use as it is" = the existing adopt → preview → activate of the tenant template code,
//     refused when already adopted, and the draft discarded if approval fails.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const SIGN_DEFAULT = '33333333-3333-7333-8333-333333333333';
const ATS_DEFAULT = '33333333-3333-7333-8333-33333333aaaa';
const OWN = '44444444-4444-7444-8444-444444444444';

const item = (over: Record<string, unknown>) => ({
  id: SIGN_DEFAULT,
  owner_scope: 'PLATFORM',
  document_type_id: 'type-1',
  name: 'NDA',
  description: null,
  template_kind: 'GENERATED',
  status: 'ACTIVE',
  client_id: null,
  current_version_id: 'v-1',
  current_version_number: 1,
  updated_at: '2026-11-01T00:00:00.000Z',
  products: ['sign'],
  withdraw_effective_at: null,
  configurable: true,
  ...over,
});

function harness(opts: { kind?: string; held?: string[]; adoptedFrom?: string | null; activateFails?: boolean } = {}) {
  const library = {
    library: vi.fn(async () => ({
      items: [
        item({}),
        item({ id: ATS_DEFAULT, products: ['ats'] }),
        item({ id: '33333333-3333-7333-8333-33333333bbbb', configurable: false }),
        item({ id: OWN, owner_scope: 'TENANT', products: null, status: 'DRAFT', current_version_id: null }),
      ],
      document_types: [{ id: 'type-1', key: 'NDA', name: 'Non-disclosure agreement', configurable: true }],
    })),
    previewDefault: vi.fn(async () => ({ title: 'NDA' })),
  };
  const tenantTemplates = {
    adopt: vi.fn(async () => ({ template: { id: 'new-t' }, version: { id: 'new-v' } })),
    previewVersion: vi.fn(async () => ({ title: 'NDA' })),
    activate: vi.fn(async () => {
      if (opts.activateFails === true) throw new Error('binding unsupported');
      return { id: 'new-v', status: 'ACTIVE' };
    }),
    deleteDraft: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ id: OWN })),
    rename: vi.fn(async () => ({ id: OWN })),
    updateVersion: vi.fn(async () => ({ id: 'v' })),
  };
  const templates = {
    listTemplates: vi.fn(async () => [{ id: OWN, adopted_from_template_id: opts.adoptedFrom ?? null }]),
    getTemplate: vi.fn(async () => ({ id: 'new-t', status: 'ACTIVE', current_version_id: 'new-v' })),
  };
  const tenants = { findById: vi.fn(async () => ({ id: TENANT, kind: opts.kind ?? 'PERSONAL' })) };
  const roles = { getScopesByUserAndTenant: vi.fn(async () => opts.held ?? ['document_template:read', 'document_template:author', 'document_template:manage']) };
  const svc = new SignTemplateStudioService({
    templates: templates as never,
    tenantTemplates: tenantTemplates as never,
    library: library as never,
    tenants: tenants as never,
    roles: roles as never,
  });
  return { svc, library, tenantTemplates, templates, roles };
}

const who = { tenant_id: TENANT, actor_id: ACTOR, requestId: 'r' };

describe('§8.5 — the Sign gallery: live Aramo defaults tagged sign only', () => {
  it('lists only configurable, current, sign-tagged defaults, with the adopted copy', async () => {
    const h = harness({ adoptedFrom: SIGN_DEFAULT });
    const out = await h.svc.gallery({ tenant_id: TENANT, requestId: 'r' });
    expect(out.items).toEqual([
      {
        template_id: SIGN_DEFAULT,
        name: 'NDA',
        description: null,
        document_type: { id: 'type-1', name: 'Non-disclosure agreement' },
        products: ['sign'],
        version_id: 'v-1',
        version_number: 1,
        updated_at: '2026-11-01T00:00:00.000Z',
        adopted_template_id: OWN,
      },
    ]);
  });

  it('preview of a default not tagged sign is 404 (never offered to Sign)', async () => {
    const h = harness();
    await expect(h.svc.galleryPreview({ tenant_id: TENANT, template_id: ATS_DEFAULT, requestId: 'r' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });
    expect(h.library.previewDefault).not.toHaveBeenCalled();
  });
});

describe('§8.5 — Use as it is', () => {
  it('an approver: adopt → record the sample preview → activate, as the person', async () => {
    const h = harness({ kind: 'BUSINESS', held: ['document_template:read', 'document_template:manage'] });
    const out = await h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT });
    expect(out).toMatchObject({ template: { id: 'new-t', status: 'ACTIVE' }, version: { id: 'new-v', status: 'ACTIVE' } });
    const actor = vi.mocked(h.tenantTemplates.adopt).mock.calls[0]?.[0] as { sub: string; tenant_id: string };
    expect(actor).toMatchObject({ sub: ACTOR, tenant_id: TENANT });
    expect(h.tenantTemplates.adopt).toHaveBeenCalledWith(expect.anything(), { library_template_id: SIGN_DEFAULT }, 'r');
    expect(h.tenantTemplates.previewVersion).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
    expect(h.tenantTemplates.activate).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
  });

  it('without document_template:manage → 403 template_approval_required, nothing written', async () => {
    const h = harness({ kind: 'BUSINESS', held: ['document_template:read', 'document_template:author'] });
    await expect(h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'template_approval_required' } },
    });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('a default not tagged sign → 404; an already adopted one → 409 already_adopted', async () => {
    const h = harness();
    await expect(h.svc.adoptAndUse({ ...who, template_id: ATS_DEFAULT })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    const a = harness({ adoptedFrom: SIGN_DEFAULT });
    await expect(a.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'already_adopted', template_id: OWN } } });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
    expect(a.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('approval refused → the new draft is discarded (audited path) and the refusal stands', async () => {
    const h = harness({ activateFails: true });
    await expect(h.svc.adoptAndUse({ ...who, template_id: SIGN_DEFAULT })).rejects.toThrow('binding unsupported');
    expect(h.tenantTemplates.deleteDraft).toHaveBeenCalledWith(expect.anything(), 'new-v', 'r');
  });
});

describe('§8.3 — the Studio: PERSONAL only, authority from live grants', () => {
  it('BUSINESS → 403 organization_templates_in_org_home on every Studio call', async () => {
    const h = harness({ kind: 'BUSINESS' });
    for (const call of [
      () => h.svc.studioList(who),
      () => h.svc.adopt({ ...who, library_template_id: SIGN_DEFAULT }),
      () => h.svc.get({ ...who, template_id: OWN }),
      () => h.svc.activate({ ...who, version_id: 'v' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'organization_templates_in_org_home' } } });
    }
    expect(h.roles.getScopesByUserAndTenant).not.toHaveBeenCalled();
  });

  it('edits need author, "Use this version" needs manage, reads need either', async () => {
    const reader = harness({ held: ['document_template:read'] });
    await expect(reader.svc.get({ ...who, template_id: OWN })).rejects.toMatchObject({ context: { details: { reason: 'template_authoring_required' } } });
    const author = harness({ held: ['document_template:read', 'document_template:author'] });
    await author.svc.rename({ ...who, template_id: OWN, name: 'Mine' });
    await expect(author.svc.activate({ ...who, version_id: 'v' })).rejects.toMatchObject({ context: { details: { reason: 'template_approval_required' } } });
  });

  it('the Studio list = own templates + sign-tagged defaults (ATS-only defaults hidden)', async () => {
    const h = harness();
    const out = await h.svc.studioList(who);
    expect(out.items.map((i) => i.id)).toEqual([SIGN_DEFAULT, OWN]);
  });

  it('adopt refuses a default not tagged sign before adopting', async () => {
    const h = harness();
    await expect(h.svc.adopt({ ...who, library_template_id: ATS_DEFAULT })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(h.tenantTemplates.adopt).not.toHaveBeenCalled();
  });

  it('only the editable version keys are forwarded', async () => {
    const h = harness();
    await h.svc.updateVersion({ ...who, version_id: 'v', body: { field_schema: { html: '' }, render_schema_version: 'rtr-html-v1' } });
    expect(h.tenantTemplates.updateVersion).toHaveBeenCalledWith(expect.anything(), 'v', { field_schema: { html: '' }, render_schema_version: 'rtr-html-v1' }, 'r');
  });
});
