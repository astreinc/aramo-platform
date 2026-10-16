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
