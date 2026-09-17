import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { ResumeSourceAuthorizer } from './resume-source-authorizer.js';
import type { ResumeAttachmentResolver } from './resume-source.types.js';

// TALENT-INTEL-1 (TI-1B, ruling 15) — the authorization seam. These prove the
// FIX_NOW: a raw/foreign/malformed résumé reference is refused BEFORE any
// storage access, on both source forms.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const FILE_UUID = '44444444-4444-4444-8444-444444444444';

// A well-formed A8-3a résumé key: {tenant}/talent/{uuid}/resume/{uuid}-{name}.
const ownTenantKey = `${TENANT_A}/talent/${DRAFT}/resume/${FILE_UUID}-Resume.pdf`;
const crossTenantKey = `${TENANT_B}/talent/${DRAFT}/resume/${FILE_UUID}-Resume.pdf`;
const nonResumeNamespaceKey = `${TENANT_A}/talent/${DRAFT}/cover_letter/${FILE_UUID}-Cover.pdf`;
const malformedKey = 'not/an/aramo/key';

const CTX = { tenant_id: TENANT_A, requestId: 'req-1' };

describe('ResumeSourceAuthorizer — CREATE draft-upload authorization', () => {
  const authorizer = new ResumeSourceAuthorizer();

  it('accepts an Aramo-issued résumé key under the authenticated tenant', () => {
    expect(authorizer.authorizeCreateDraftUpload(ownTenantKey, CTX)).toEqual({
      storage_key: ownTenantKey,
    });
  });

  it('REJECTS a cross-tenant key before object access (the ruling-15 hole)', () => {
    try {
      authorizer.authorizeCreateDraftUpload(crossTenantKey, CTX);
      throw new Error('expected a cross-tenant key to be rejected');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      const err = e as AramoError;
      expect(err.code).toBe('RESUME_SOURCE_UNAUTHORIZED');
      expect(err.statusCode).toBe(403);
      expect((err.context.details as { reason?: string }).reason).toBe('tenant_mismatch');
    }
  });

  it('REJECTS a malformed / non-Aramo key', () => {
    expect(() => authorizer.authorizeCreateDraftUpload(malformedKey, CTX)).toThrowError(
      /RESUME_SOURCE_UNAUTHORIZED|not authorized/,
    );
  });

  it('REJECTS an Aramo key OUTSIDE the résumé-upload namespace', () => {
    try {
      authorizer.authorizeCreateDraftUpload(nonResumeNamespaceKey, CTX);
      throw new Error('expected a non-résumé namespace key to be rejected');
    } catch (e) {
      const err = e as AramoError;
      expect(err.code).toBe('RESUME_SOURCE_UNAUTHORIZED');
      expect((err.context.details as { reason?: string }).reason).toBe('not_resume_namespace');
    }
  });

  it('dispatch: authorize(CREATE_DRAFT_UPLOAD) validates the key', async () => {
    await expect(
      authorizer.authorize({ kind: 'CREATE_DRAFT_UPLOAD', storage_key: ownTenantKey }, CTX),
    ).resolves.toEqual({ storage_key: ownTenantKey });
  });
});

describe('ResumeSourceAuthorizer — ATTACHMENT (EDIT) authorization', () => {
  it('fails LOUDLY when the ATTACHMENT path is invoked with no bound resolver', async () => {
    const authorizer = new ResumeSourceAuthorizer(); // no resolver
    await expect(
      authorizer.authorize(
        { kind: 'ATTACHMENT', attachment_id: 'att-1', talent_id: 'tal-1' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
  });

  it('delegates to the bound resolver and returns its resolved storage_key', async () => {
    const resolver: ResumeAttachmentResolver = {
      resolveOwnedResumeStorageKey: vi
        .fn()
        .mockResolvedValue({ storage_key: 'resolved/owned/key' }),
    };
    const authorizer = new ResumeSourceAuthorizer(resolver);
    await expect(
      authorizer.authorize(
        { kind: 'ATTACHMENT', attachment_id: 'att-1', talent_id: 'tal-1' },
        CTX,
      ),
    ).resolves.toEqual({ storage_key: 'resolved/owned/key' });
    expect(resolver.resolveOwnedResumeStorageKey).toHaveBeenCalledWith({
      attachment_id: 'att-1',
      talent_id: 'tal-1',
      tenant_id: TENANT_A,
      requestId: 'req-1',
    });
  });
});
