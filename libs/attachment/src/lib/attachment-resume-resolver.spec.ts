import { describe, expect, it, vi } from 'vitest';

import { AttachmentResumeResolver } from './attachment-resume-resolver.js';
import type { AttachmentRepository } from './attachment.repository.js';
import type { AttachmentView } from './dto/index.js';

// TALENT-INTEL-1 (TI-1B, ruling 15) — the EDIT/re-extraction ownership seam.
// The client never supplies the authoritative storage_key: an owned
// attachment_id resolves to a key ONLY after tenant + Talent + is_resume
// ownership is verified against the tenant-scoped row.

const TENANT = 'tenant-1';
const TALENT = 'talent-1';
const CTX = { attachment_id: 'att-1', talent_id: TALENT, tenant_id: TENANT, requestId: 'req-1' };

function view(overrides: Partial<AttachmentView>): AttachmentView {
  return {
    id: 'att-1',
    tenant_id: TENANT,
    site_id: null,
    owner_type: 'talent',
    owner_id: TALENT,
    file_name: 'Resume.pdf',
    mime: 'application/pdf',
    size_bytes: 1024,
    storage_key: `${TENANT}/talent/${TALENT}/resume/uuid-Resume.pdf`,
    is_resume: true,
    uploaded_by_id: 'user-1',
    uploaded_at: '2026-09-16T00:00:00.000Z',
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeResolver(findByIdResult: AttachmentView | null) {
  const repo = {
    findById: vi.fn().mockResolvedValue(findByIdResult),
  } as unknown as AttachmentRepository;
  return { resolver: new AttachmentResumeResolver(repo), repo };
}

describe('AttachmentResumeResolver', () => {
  it('resolves storage_key for an in-tenant résumé attachment owned by the Talent', async () => {
    const { resolver, repo } = makeResolver(view({}));
    await expect(resolver.resolveOwnedResumeStorageKey(CTX)).resolves.toEqual({
      storage_key: `${TENANT}/talent/${TALENT}/resume/uuid-Resume.pdf`,
    });
    // Ownership is resolved via the TENANT-SCOPED repository (not a raw key).
    expect(repo.findById).toHaveBeenCalledWith({ tenant_id: TENANT, id: 'att-1' });
  });

  it('REJECTS when the attachment is absent in-tenant (incl. cross-tenant ids)', async () => {
    const { resolver } = makeResolver(null);
    await expect(resolver.resolveOwnedResumeStorageKey(CTX)).rejects.toMatchObject({
      code: 'RESUME_SOURCE_UNAUTHORIZED',
      statusCode: 403,
    });
  });

  it('REJECTS when the attachment is owned by a different Talent', async () => {
    const { resolver } = makeResolver(view({ owner_id: 'someone-else' }));
    await expect(resolver.resolveOwnedResumeStorageKey(CTX)).rejects.toMatchObject({
      code: 'RESUME_SOURCE_UNAUTHORIZED',
    });
  });

  it('REJECTS when owner_type is not talent', async () => {
    const { resolver } = makeResolver(view({ owner_type: 'requisition' }));
    await expect(resolver.resolveOwnedResumeStorageKey(CTX)).rejects.toMatchObject({
      code: 'RESUME_SOURCE_UNAUTHORIZED',
    });
  });

  it('REJECTS a non-résumé attachment', async () => {
    const { resolver } = makeResolver(view({ is_resume: false }));
    await expect(resolver.resolveOwnedResumeStorageKey(CTX)).rejects.toMatchObject({
      code: 'RESUME_SOURCE_UNAUTHORIZED',
    });
  });
});
