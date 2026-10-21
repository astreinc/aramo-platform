import { describe, expect, it, vi } from 'vitest';

import { TemplatesRepository } from '../index.js';

// DOC-TEMPLATE-LIB-1 T-1 §4.1 / §4.4 — the owner-aware reads issue an EXPLICIT
// own-tenant ∪ PLATFORM union (the PLATFORM arm names owner_scope, so a NULL
// tenant_id never matches by accident). The pre-existing tenant-only reads keep
// their exact tenant-only predicate (behaviour-neutral). Pure fakes (no DB).

function repoWith(prisma: Record<string, unknown>): TemplatesRepository {
  return new TemplatesRepository(prisma as never);
}

const PLATFORM_ARM = { owner_scope: 'PLATFORM', tenant_id: null };

describe('TemplatesRepository — DOC-TEMPLATE-LIB-1 T-1 read union', () => {
  it('findTemplateByIdOwnerAware unions own tenant with PLATFORM', async () => {
    const findFirst = vi.fn(async () => null);
    await repoWith({ documentTemplate: { findFirst } }).findTemplateByIdOwnerAware('t-1', 'tpl-1');
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'tpl-1', OR: [{ tenant_id: 't-1' }, PLATFORM_ARM] } });
  });

  it('findVersionByIdOwnerAware unions own tenant with versions of a PLATFORM template', async () => {
    const findFirst = vi.fn(async () => null);
    await repoWith({ templateVersion: { findFirst } }).findVersionByIdOwnerAware('t-1', 'v-1');
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'v-1', OR: [{ tenant_id: 't-1' }, { tenant_id: null, template: { owner_scope: 'PLATFORM' } }] },
    });
  });

  it('listTemplatesForTenantIncludingPlatform unions, optionally narrowed by document type', async () => {
    const findMany = vi.fn(async () => []);
    const repo = repoWith({ documentTemplate: { findMany } });
    await repo.listTemplatesForTenantIncludingPlatform('t-1');
    await repo.listTemplatesForTenantIncludingPlatform('t-1', 'type-1');
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { OR: [{ tenant_id: 't-1' }, PLATFORM_ARM] },
      orderBy: { created_at: 'desc' },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { document_type_id: 'type-1', OR: [{ tenant_id: 't-1' }, PLATFORM_ARM] },
      orderBy: { created_at: 'desc' },
    });
  });

  it('tenant-only reads are unchanged (no PLATFORM arm)', async () => {
    const tplFindFirst = vi.fn(async () => null);
    const tplFindMany = vi.fn(async () => []);
    const verFindFirst = vi.fn(async () => null);
    const assetFindFirst = vi.fn(async () => null);
    const repo = repoWith({
      documentTemplate: { findFirst: tplFindFirst, findMany: tplFindMany },
      templateVersion: { findFirst: verFindFirst },
      templateAsset: { findFirst: assetFindFirst },
    });
    await repo.findTemplateById('t-1', 'tpl-1');
    await repo.findVersionById('t-1', 'v-1');
    await repo.findAssetById('t-1', 'a-1');
    await repo.listTemplates('t-1');
    await repo.findActiveTenantTemplateForType('t-1', 'type-1');
    expect(tplFindFirst).toHaveBeenNthCalledWith(1, { where: { tenant_id: 't-1', id: 'tpl-1' } });
    expect(verFindFirst).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'v-1' } });
    expect(assetFindFirst).toHaveBeenCalledWith({ where: { tenant_id: 't-1', id: 'a-1' } });
    expect(tplFindMany).toHaveBeenCalledWith({ where: { tenant_id: 't-1' }, orderBy: { created_at: 'desc' } });
    expect(tplFindFirst).toHaveBeenNthCalledWith(2, {
      where: { tenant_id: 't-1', document_type_id: 'type-1', client_id: null, status: 'ACTIVE' },
    });
  });
});
