import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import {
  DocumentTemplatesController,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
  TemplatesRepository,
} from '../index.js';

// Document Templates slice 1 (A, PO ruling 2) — PATCH /v1/document-templates/:id { name };
// (B) DELETE /v1/document-templates/versions/:versionId (discard the open DRAFT).
// The template name is saved on the TEMPLATE (DocumentTemplate.name). Pure fakes (no DB):
// the controller trims + validates 1..120 chars and maps not-found to 404; the repo writes
// ONLY `name`, tenant-scoped, and conceals unknown / cross-tenant ids as not-found.

const AUTH = { tenant_id: 't-1', sub: 'u-1' } as never;

function controllerWith(repo: Partial<TemplatesRepository>): DocumentTemplatesController {
  return new DocumentTemplatesController(repo as TemplatesRepository);
}

// B1 — internal_notes on PATCH versions/:versionId (DRAFT-only, trimmed, ≤500, never rendered).
describe('PATCH /v1/document-templates/versions/:versionId — internal_notes (B1)', () => {
  it('a notes-only update trims and forwards internal_notes WITHOUT field_schema', async () => {
    const updateDraftVersion = vi.fn(async () => ({}));
    await controllerWith({ updateDraftVersion } as never).updateVersion(AUTH, 'v-1', { internal_notes: '  Legal asked for clause 3  ' }, 'r');
    expect(updateDraftVersion).toHaveBeenCalledWith({ tenant_id: 't-1', version_id: 'v-1', render_schema_version: undefined, internal_notes: 'Legal asked for clause 3' });
  });

  it('null or blank notes clear to null; 500 chars accepted, 501 rejected; non-string rejected', async () => {
    const updateDraftVersion = vi.fn(async () => ({}));
    const c = controllerWith({ updateDraftVersion } as never);
    await c.updateVersion(AUTH, 'v-1', { internal_notes: null }, 'r');
    await c.updateVersion(AUTH, 'v-1', { internal_notes: '   ' }, 'r');
    await c.updateVersion(AUTH, 'v-1', { internal_notes: 'n'.repeat(500) }, 'r');
    expect(updateDraftVersion.mock.calls.map((a) => (a as unknown as [{ internal_notes: unknown }])[0].internal_notes)).toEqual([null, null, 'n'.repeat(500)]);
    await expectAramo(c.updateVersion(AUTH, 'v-1', { internal_notes: 'n'.repeat(501) }, 'r'), 'VALIDATION_ERROR', 400);
    await expectAramo(c.updateVersion(AUTH, 'v-1', { internal_notes: 7 } as never, 'r'), 'VALIDATION_ERROR', 400);
    expect(updateDraftVersion).toHaveBeenCalledTimes(3);
  });

  it('a body with neither field_schema nor internal_notes is 400', async () => {
    const updateDraftVersion = vi.fn();
    await expectAramo(controllerWith({ updateDraftVersion } as never).updateVersion(AUTH, 'v-1', {} as never, 'r'), 'VALIDATION_ERROR', 400);
    expect(updateDraftVersion).not.toHaveBeenCalled();
  });

  it('content + notes together forward both', async () => {
    const updateDraftVersion = vi.fn(async () => ({}));
    await controllerWith({ updateDraftVersion } as never).updateVersion(AUTH, 'v-1', { field_schema: { a: 1 }, internal_notes: 'x' }, 'r');
    expect(updateDraftVersion).toHaveBeenCalledWith({ tenant_id: 't-1', version_id: 'v-1', field_schema: { a: 1 }, render_schema_version: undefined, internal_notes: 'x' });
  });
});

describe('TemplatesRepository.updateDraftVersion — internal_notes (B1)', () => {
  function repoWith(version: { status: string; field_schema?: unknown }) {
    const update = vi.fn(async (a: unknown) => a);
    const prisma = { templateVersion: { findFirst: vi.fn(async () => ({ id: 'v-1', ...version })), update } };
    return { repo: new TemplatesRepository(prisma as never), update };
  }

  it('a notes-only edit writes internal_notes and leaves the fingerprints (preview gate) untouched', async () => {
    const { repo, update } = repoWith({ status: 'DRAFT', field_schema: { t: 1 } });
    await repo.updateDraftVersion({ tenant_id: 't-1', version_id: 'v-1', internal_notes: 'why' });
    const data = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ internal_notes: 'why' });
  });

  it('a content edit re-arms the preview gate (clears previewed_fingerprint)', async () => {
    const { repo, update } = repoWith({ status: 'DRAFT' });
    await repo.updateDraftVersion({ tenant_id: 't-1', version_id: 'v-1', field_schema: { t: 2 } });
    const data = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data['previewed_fingerprint']).toBeNull();
    expect(typeof data['content_fingerprint']).toBe('string');
  });

  it.each(['ACTIVE', 'RETIRED'])('notes on a %s version are refused (TemplateImmutableError)', async (status) => {
    const { repo, update } = repoWith({ status });
    await expect(repo.updateDraftVersion({ tenant_id: 't-1', version_id: 'v-1', internal_notes: 'x' })).rejects.toBeInstanceOf(TemplateImmutableError);
    expect(update).not.toHaveBeenCalled();
  });
});

async function expectAramo(p: Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await p;
    throw new Error(`expected AramoError ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    expect((e as AramoError).code).toBe(code);
    expect((e as AramoError).statusCode).toBe(status);
  }
}

describe('PATCH /v1/document-templates/:id — controller', () => {
  it('trims the name, renames tenant-scoped, and returns the template view', async () => {
    const view = { id: 'tpl-1', tenant_id: 't-1', name: 'Exclusive RTR' };
    const renameTemplate = vi.fn(async () => view);
    const res = await controllerWith({ renameTemplate } as never).rename(AUTH, 'tpl-1', { name: '  Exclusive RTR  ' }, 'r-1');
    expect(res).toBe(view);
    expect(renameTemplate).toHaveBeenCalledWith({ tenant_id: 't-1', id: 'tpl-1', name: 'Exclusive RTR' });
  });

  it('rejects a missing, blank, or non-string name (400 VALIDATION_ERROR) without writing', async () => {
    const renameTemplate = vi.fn();
    const c = controllerWith({ renameTemplate } as never);
    await expectAramo(c.rename(AUTH, 'tpl-1', {} as never, 'r'), 'VALIDATION_ERROR', 400);
    await expectAramo(c.rename(AUTH, 'tpl-1', { name: '   ' }, 'r'), 'VALIDATION_ERROR', 400);
    await expectAramo(c.rename(AUTH, 'tpl-1', { name: 42 } as never, 'r'), 'VALIDATION_ERROR', 400);
    expect(renameTemplate).not.toHaveBeenCalled();
  });

  it('accepts exactly 120 characters and rejects 121', async () => {
    const renameTemplate = vi.fn(async () => ({}));
    const c = controllerWith({ renameTemplate } as never);
    await c.rename(AUTH, 'tpl-1', { name: 'a'.repeat(120) }, 'r');
    await expectAramo(c.rename(AUTH, 'tpl-1', { name: 'a'.repeat(121) }, 'r'), 'VALIDATION_ERROR', 400);
    expect(renameTemplate).toHaveBeenCalledTimes(1);
  });

  it('maps an unknown / cross-tenant template to 404 TEMPLATE_NOT_FOUND', async () => {
    const renameTemplate = vi.fn(async () => {
      throw new TemplateNotFoundError('tpl-x');
    });
    await expectAramo(controllerWith({ renameTemplate } as never).rename(AUTH, 'tpl-x', { name: 'N' }, 'r'), 'TEMPLATE_NOT_FOUND', 404);
  });
});

describe('TemplatesRepository.renameTemplate', () => {
  it('updates ONLY name, filtered by tenant_id + id, then returns the tenant-scoped read', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findFirst = vi.fn(async () => ({ id: 'tpl-1', tenant_id: 't-1', name: 'New' }));
    const repo = new TemplatesRepository({ documentTemplate: { updateMany, findFirst } } as never);
    const out = await repo.renameTemplate({ tenant_id: 't-1', id: 'tpl-1', name: 'New' });
    expect(updateMany).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'tpl-1' }, data: { name: 'New' } });
    expect(findFirst).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'tpl-1' } });
    expect(out).toMatchObject({ name: 'New' });
  });

  it('a cross-tenant / unknown id matches 0 rows → TemplateNotFoundError (no other tenant row touched)', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const repo = new TemplatesRepository({ documentTemplate: { updateMany, findFirst: vi.fn() } } as never);
    await expect(repo.renameTemplate({ tenant_id: 't-2', id: 'tpl-1', name: 'X' })).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

describe('DELETE /v1/document-templates/versions/:versionId — controller (A1 §1 audit)', () => {
  const DRAFT = { id: 'v-1', template_id: 'tpl-1', version_number: 4, status: 'DRAFT' };

  function withAudit(version: unknown, audit?: { recordDraftDiscarded: ReturnType<typeof vi.fn> }) {
    const order: string[] = [];
    const repo = {
      getVersion: vi.fn(async () => {
        if (version instanceof Error) throw version;
        return version;
      }),
      deleteDraftVersion: vi.fn(async () => {
        order.push('delete');
      }),
    };
    const port = audit ?? {
      recordDraftDiscarded: vi.fn(async () => {
        order.push('audit');
      }),
    };
    const c = new DocumentTemplatesController(repo as never, undefined, port as never);
    return { c, repo, port, order };
  }

  it('writes the template audit event (actor, version) BEFORE deleting, then returns nothing (204)', async () => {
    const { c, repo, port, order } = withAudit(DRAFT);
    expect(await c.deleteDraft(AUTH, 'v-1', 'r-9')).toBeUndefined();
    expect(port.recordDraftDiscarded).toHaveBeenCalledWith({
      tenant_id: 't-1',
      actor_id: 'u-1',
      template_id: 'tpl-1',
      version_id: 'v-1',
      version_number: 4,
      requestId: 'r-9',
    });
    expect(repo.deleteDraftVersion).toHaveBeenCalledWith({ tenant_id: 't-1', version_id: 'v-1' });
    expect(order).toEqual(['audit', 'delete']);
  });

  it('no audit, no discard — an audit write failure refuses the delete', async () => {
    const failing = { recordDraftDiscarded: vi.fn(async () => { throw new Error('audit down'); }) };
    const { c, repo } = withAudit(DRAFT, failing);
    await expectAramo(c.deleteDraft(AUTH, 'v-1', 'r'), 'INTERNAL_ERROR', 500);
    expect(repo.deleteDraftVersion).not.toHaveBeenCalled();
  });

  it('refuses when no audit port is wired (500) without deleting', async () => {
    const repo = { getVersion: vi.fn(async () => DRAFT), deleteDraftVersion: vi.fn() };
    const c = new DocumentTemplatesController(repo as never);
    await expectAramo(c.deleteDraft(AUTH, 'v-1', 'r'), 'INTERNAL_ERROR', 500);
    expect(repo.deleteDraftVersion).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'RETIRED'])('a %s version → 409 TEMPLATE_IMMUTABLE, no audit, no delete', async (status) => {
    const { c, repo, port } = withAudit({ ...DRAFT, status });
    await expectAramo(c.deleteDraft(AUTH, 'v-1', 'r'), 'TEMPLATE_IMMUTABLE', 409);
    expect(port.recordDraftDiscarded).not.toHaveBeenCalled();
    expect(repo.deleteDraftVersion).not.toHaveBeenCalled();
  });

  it('unknown / cross-tenant version → 404 TEMPLATE_VERSION_NOT_FOUND, no audit', async () => {
    const { c, port } = withAudit(new TemplateVersionNotFoundError('v-x'));
    await expectAramo(c.deleteDraft(AUTH, 'v-x', 'r'), 'TEMPLATE_VERSION_NOT_FOUND', 404);
    expect(port.recordDraftDiscarded).not.toHaveBeenCalled();
  });
});

describe('TemplatesRepository.deleteDraftVersion', () => {
  function repoWith(version: { status: string } | null, deletedCount = 1) {
    const fieldDeleteMany = vi.fn(async () => ({ count: 2 }));
    const versionDeleteMany = vi.fn(async () => ({ count: deletedCount }));
    const tx = { templateFieldDefinition: { deleteMany: fieldDeleteMany }, templateVersion: { deleteMany: versionDeleteMany } };
    const prisma = {
      templateVersion: { findFirst: vi.fn(async () => (version === null ? null : { id: 'v-1', ...version })) },
      documentTemplate: { update: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { repo: new TemplatesRepository(prisma as never), prisma, fieldDeleteMany, versionDeleteMany };
  }

  it('deletes the DRAFT field definitions then the DRAFT row (status-guarded), never touching the template', async () => {
    const { repo, prisma, fieldDeleteMany, versionDeleteMany } = repoWith({ status: 'DRAFT' });
    await repo.deleteDraftVersion({ tenant_id: 't-1', version_id: 'v-1' });
    expect(prisma.templateVersion.findFirst).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'v-1' } });
    expect(fieldDeleteMany).toHaveBeenCalledWith({ where: { template_version_id: 'v-1' } });
    expect(versionDeleteMany).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'v-1', status: 'DRAFT' } });
    expect(prisma.documentTemplate.update).not.toHaveBeenCalled();
    expect(prisma.documentTemplate.updateMany).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'RETIRED'])('refuses a %s version (TemplateImmutableError) with no delete', async (status) => {
    const { repo, prisma } = repoWith({ status });
    await expect(repo.deleteDraftVersion({ tenant_id: 't-1', version_id: 'v-1' })).rejects.toBeInstanceOf(TemplateImmutableError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('unknown / cross-tenant version → TemplateVersionNotFoundError', async () => {
    const { repo } = repoWith(null);
    await expect(repo.deleteDraftVersion({ tenant_id: 't-2', version_id: 'v-1' })).rejects.toBeInstanceOf(TemplateVersionNotFoundError);
  });

  it('a version activated between read and delete (0 rows) is refused as immutable', async () => {
    const { repo } = repoWith({ status: 'DRAFT' }, 0);
    await expect(repo.deleteDraftVersion({ tenant_id: 't-1', version_id: 'v-1' })).rejects.toBeInstanceOf(TemplateImmutableError);
  });
});

// Amendment A1 — editor v2 controller surface: PATCH normalisation through the capability
// port, draft-creation transform, version `logo` view, allowed-bindings tenant_logo, and
// the logo capture / remove / content routes (DRAFT-only capture; asset frozen).
describe('A1 — templates controller (html content + tenant logo)', () => {
  const RTR_TYPE = 'type-rtr';
  const LOGO = { asset_id: 'asset-1', sha256: 's'.repeat(64), mime: 'image/png' as const };

  function caps(over: Record<string, unknown> = {}) {
    return {
      isConfigurable: (t: string) => t === RTR_TYPE,
      listAllowedBindings: () => [{ key: 'talent.full_name', label: 'Talent full name', group: 'Talent' }],
      validateDraftContent: vi.fn(),
      renderSamplePreview: vi.fn(),
      normalizeDraftContent: vi.fn((i: { field_schema: unknown }) => ({ ...(i.field_schema as object), html: '<p>clean</p>' })),
      draftContentFrom: vi.fn(() => ({ render_schema_version: 'rtr-html-v1', field_schema: { html: '<p>converted</p>' } })),
      logoOf: (fs: unknown) => ((fs as { logo?: unknown } | null)?.logo as typeof LOGO | undefined) ?? null,
      withLogo: vi.fn((fs: unknown, logo: unknown) => ({ ...(fs as object), logo })),
      ...over,
    };
  }
  function repo(version: Record<string, unknown> = {}) {
    const v = { id: 'v-1', template_id: 'tpl-1', status: 'DRAFT', render_schema_version: 'rtr-html-v1', field_schema: { html: '<p>x</p>', logo: null }, ...version };
    return {
      getVersion: vi.fn(async () => v),
      getTemplate: vi.fn(async () => ({ id: 'tpl-1', document_type_id: RTR_TYPE })),
      updateDraftVersion: vi.fn(async (i: { field_schema?: unknown }) => ({ ...v, field_schema: i.field_schema ?? v.field_schema })),
      createDraftFromActive: vi.fn(async (i: { transform?: (c: unknown) => { field_schema: unknown } }) => ({
        ...v,
        field_schema: i.transform ? i.transform({ render_schema_version: 'rtr-generated-v1', field_schema: {} }).field_schema : {},
      })),
      createAsset: vi.fn(async () => ({ id: 'asset-9' })),
      findAssetById: vi.fn(async () => ({ id: 'asset-1', storage_locator: 'loc', mime_type: 'image/png' })),
      listVersions: vi.fn(async () => [v]),
    };
  }
  function logoPort(over: Record<string, unknown> = {}) {
    return {
      info: vi.fn(async () => ({ available: true, tenant_name: 'Astre' })),
      capture: vi.fn(async () => ({ sha256: 'h'.repeat(64), mime: 'image/png', storage_provider: 'aramo-s3', storage_locator: 'loc-9', byte_size: 10 })),
      read: vi.fn(async () => Buffer.from([1, 2, 3])),
      ...over,
    };
  }
  const ctl = (r: unknown, c: unknown, l?: unknown) => new DocumentTemplatesController(r as never, c as never, undefined, l as never);

  it('PATCH routes content through normalizeDraftContent (existing content + effective version) and returns the sanitised html + logo view', async () => {
    const r = repo({ field_schema: { html: '<p>old</p>', logo: LOGO } });
    const c = caps();
    const out = (await ctl(r, c).updateVersion(AUTH, 'v-1', { field_schema: { title: 'T', html: '<p onclick=x>new</p>' } }, 'r')) as unknown as {
      field_schema: { html: string };
      logo: unknown;
    };
    expect(c.normalizeDraftContent).toHaveBeenCalledWith({
      document_type_id: RTR_TYPE,
      render_schema_version: 'rtr-html-v1',
      field_schema: { title: 'T', html: '<p onclick=x>new</p>' },
      existing_field_schema: { html: '<p>old</p>', logo: LOGO },
      requestId: 'r',
    });
    expect(out.field_schema.html).toBe('<p>clean</p>');
    expect(r.updateDraftVersion.mock.calls[0]?.[0]).toMatchObject({ field_schema: { title: 'T', html: '<p>clean</p>' } });
  });

  it('PATCH on a non-DRAFT version is refused before sanitising (409 TEMPLATE_IMMUTABLE)', async () => {
    const c = caps();
    await expectAramo(ctl(repo({ status: 'ACTIVE' }), c).updateVersion(AUTH, 'v-1', { field_schema: {} }, 'r'), 'TEMPLATE_IMMUTABLE', 409);
    expect(c.normalizeDraftContent).not.toHaveBeenCalled();
  });

  it('createDraft passes the capability transform (v1 → html conversion) to the repo', async () => {
    const r = repo();
    const c = caps();
    const out = (await ctl(r, c).createDraft(AUTH, 'tpl-1', 'r')) as unknown as { field_schema: unknown };
    expect(c.draftContentFrom).toHaveBeenCalledWith({ document_type_id: RTR_TYPE, render_schema_version: 'rtr-generated-v1', field_schema: {} });
    expect(out.field_schema).toEqual({ html: '<p>converted</p>' });
  });

  it('version reads carry logo {asset_id, mime} or null', async () => {
    const withLogo = await ctl(repo({ field_schema: { html: '', logo: LOGO } }), caps()).getVersion(AUTH, 'v-1', 'r');
    expect(withLogo.logo).toEqual({ asset_id: 'asset-1', mime: 'image/png' });
    const list = await ctl(repo(), caps()).listVersions(AUTH, 'tpl-1', 'r');
    expect(list[0]?.logo).toBeNull();
  });

  it('allowed-bindings additionally returns tenant_logo {available, tenant_name}', async () => {
    const res = await ctl(repo(), caps(), logoPort()).allowedBindings(AUTH, 'tpl-1', 'r');
    expect(res.tenant_logo).toEqual({ available: true, tenant_name: 'Astre' });
    const none = await ctl(repo(), caps()).allowedBindings(AUTH, 'tpl-1', 'r');
    expect(none.tenant_logo).toEqual({ available: false, tenant_name: null });
  });

  // TEMPLATE-STUDIO-1 B-2 (§6) — the catalog metadata the port supplies (data_type,
  // sample_value, active) reaches the tenant response unchanged (additive fields).
  it('allowed-bindings passes the B-2 catalog metadata (data_type, sample_value, active) through', async () => {
    const binding = { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', data_type: 'TEXT', sample_value: 'Amina Diallo', active: true };
    const res = await ctl(repo(), caps({ listAllowedBindings: () => [binding] }), logoPort()).allowedBindings(AUTH, 'tpl-1', 'r');
    expect(res.bindings).toEqual([binding]);
  });

  it('POST logo: captures once, creates a LOGO TemplateAsset, attaches it to the DRAFT content, returns {asset_id, sha256, mime}', async () => {
    const r = repo();
    const c = caps();
    const l = logoPort();
    const out = await ctl(r, c, l).captureLogo(AUTH, 'v-1', 'r');
    expect(out).toEqual({ asset_id: 'asset-9', sha256: 'h'.repeat(64), mime: 'image/png' });
    expect(r.createAsset).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't-1', asset_kind: 'LOGO', storage_locator: 'loc-9', name: 'tenant.logo', created_by: 'u-1' }));
    expect(c.withLogo).toHaveBeenCalledWith({ html: '<p>x</p>', logo: null }, { asset_id: 'asset-9', sha256: 'h'.repeat(64), mime: 'image/png' }, 'r');
    expect(r.updateDraftVersion).toHaveBeenCalledTimes(1);
  });

  it('POST logo on ACTIVE → 409 TEMPLATE_IMMUTABLE (no fetch); no tenant logo → the port 409 surfaces unchanged', async () => {
    const l = logoPort();
    await expectAramo(ctl(repo({ status: 'ACTIVE' }), caps(), l).captureLogo(AUTH, 'v-1', 'r'), 'TEMPLATE_IMMUTABLE', 409);
    expect(l.capture).not.toHaveBeenCalled();
    const noLogo = logoPort({ capture: vi.fn(async () => { throw new AramoError('VALIDATION_ERROR', 'no logo', 409, { requestId: 'r', details: { reason: 'no_tenant_logo' } }); }) });
    await expectAramo(ctl(repo(), caps(), noLogo).captureLogo(AUTH, 'v-1', 'r'), 'VALIDATION_ERROR', 409);
  });

  it('DELETE logo detaches (withLogo null) on a DRAFT; GET logo/content streams the frozen bytes with the asset mime', async () => {
    const r = repo({ field_schema: { html: '', logo: LOGO } });
    const c = caps();
    await ctl(r, c, logoPort()).removeLogo(AUTH, 'v-1', 'r');
    expect(c.withLogo).toHaveBeenCalledWith({ html: '', logo: LOGO }, null, 'r');
    const file = await ctl(r, c, logoPort()).logoContent(AUTH, 'v-1', 'r');
    expect(file.getHeaders().type).toBe('image/png');
    await expectAramo(ctl(repo(), caps(), logoPort()).logoContent(AUTH, 'v-1', 'r'), 'TEMPLATE_VERSION_NOT_FOUND', 404);
  });
});
