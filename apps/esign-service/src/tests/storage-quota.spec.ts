import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { EntitlementRepository } from '@aramo/entitlement';
import type { TenantRepository } from '@aramo/identity';
import type { CapacityService } from '@aramo/subscription';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { AramoSignStorageGate, storageRef } from '../app/billing/aramo-sign-storage.gate.js';
import { AtsPlanEligibilityAdapter } from '../app/billing/ats-plan-eligibility.adapter.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// Commercial Plans Amendment A1 — storage allocation at the upload seam, kept
// artifacts measured but never refused, and the ATS eligibility rule.

const AUTH = { sub: 'u1', tenant_id: 't1', scopes: [], consumer_type: 'esign' } as unknown as AuthContextType;

describe('AramoSignStorageGate', () => {
  const gate = (reserve: CapacityService['reserve']) => {
    const capacity = { reserve: vi.fn(reserve), release: vi.fn(async () => true) } as unknown as CapacityService;
    return { g: new AramoSignStorageGate(capacity), capacity };
  };

  it('a full allocation is a typed 409 with used / limit / requested; no plan is ESIGN_NOT_SUBSCRIBED', async () => {
    const full = gate(async () => ({ ok: false, reason: 'CAPACITY_EXCEEDED', status: { capacity_key: 'esign.storage_bytes', limit: 100, unlimited: false, used: 90 } }));
    await expect(full.g.reserveUpload('t1', 'k', 20, 'r')).rejects.toMatchObject({
      code: 'ESIGN_STORAGE_QUOTA_EXCEEDED',
      statusCode: 409,
      context: { details: { reason: 'CAPACITY_EXCEEDED', used: 90, limit: 100, requested: 20 } },
    });
    const none = gate(async () => ({ ok: false, reason: 'NOT_SUBSCRIBED', status: null }));
    await expect(none.g.reserveUpload('t1', 'k', 20, 'r')).rejects.toMatchObject({ code: 'ESIGN_NOT_SUBSCRIBED', statusCode: 403 });
  });

  it('kept artifacts are recorded with enforcement off; release frees the object', async () => {
    const { g, capacity } = gate(async () => ({ ok: true, already: false, status: { capacity_key: 'esign.storage_bytes', limit: 1, unlimited: false, used: 999 } }));
    await g.recordKept({ tenant_id: 't1', ref: 'esign:executed:d1', bytes: 999 });
    expect(capacity.reserve).toHaveBeenCalledWith({ tenant_id: 't1', capacity_key: 'esign.storage_bytes', ref: 'esign:executed:d1', quantity: 999, enforce: false });
    await g.release('t1', 'esign/source/t1/e1/o1');
    expect(capacity.release).toHaveBeenCalledWith({ tenant_id: 't1', capacity_key: 'esign.storage_bytes', ref: storageRef('esign/source/t1/e1/o1') });
  });
});

describe('SenderEnvelopeService upload — storage reserved before the write', () => {
  async function harness(reserve: () => Promise<void>, put: () => Promise<unknown>) {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const content_base64 = Buffer.from(await pdf.save()).toString('base64');
    const storageGate = { reserveUpload: vi.fn(reserve), release: vi.fn(async () => undefined) };
    const storage = { putOwnedSource: vi.fn(put) };
    const repo = {
      addDraftDocument: vi.fn(async () => ({ id: 'd1', title: 'T', ordinal: 0, byte_size: 10 })),
      removeDraftDocument: vi.fn(async () => ({ source_object_key: 'esign/source/t1/e1/obj' })),
      getEnvelopeDetail: vi.fn(async () => ({ source_application: 'aramo-sign', id: 'e1', subject: 'S', status: 'DRAFT', created_by: 'u1', created_at: new Date(), sent_at: null, completed_at: null, declined_at: null, voided_at: null, documents: [], signers: [] })),
    };
    const ctx = { assertCanAuthor: vi.fn(async () => undefined), tenantKind: vi.fn(async () => 'BUSINESS') };
    const svc = new SenderEnvelopeService(repo as never, {} as never, ctx as never, { findUserById: vi.fn(async () => null) } as never, storage as never, {} as never, storageGate as never);
    return { svc, storageGate, storage, repo, content_base64 };
  }

  it('reserves the exact bytes under the planned object key, then writes with that object id', async () => {
    const h = await harness(async () => undefined, async () => ({ source_object_key: 'x', byte_size: 10, source_sha256: 'a'.repeat(64) }));
    await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: h.content_base64 } as never, 'r');
    const [tenant, key, bytes] = h.storageGate.reserveUpload.mock.calls[0]!;
    expect(tenant).toBe('t1');
    expect(key).toMatch(/^esign\/source\/t1\/e1\/[0-9a-f-]{36}$/);
    expect(bytes).toBeGreaterThan(0);
    expect(h.storage.putOwnedSource).toHaveBeenCalledWith(expect.objectContaining({ object_id: (key as string).split('/').at(-1) }));
  });

  it('a full allocation stops the upload before anything is written', async () => {
    const h = await harness(async () => {
      throw new AramoError('ESIGN_STORAGE_QUOTA_EXCEEDED', 'full', 409, { requestId: 'r' });
    }, async () => ({}));
    await expect(h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: h.content_base64 } as never, 'r')).rejects.toMatchObject({ code: 'ESIGN_STORAGE_QUOTA_EXCEEDED' });
    expect(h.storage.putOwnedSource).not.toHaveBeenCalled();
  });

  it('a failed write releases the reservation; removing a draft document releases its space', async () => {
    const h = await harness(async () => undefined, async () => {
      throw new Error('S3 down');
    });
    await expect(h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: h.content_base64 } as never, 'r')).rejects.toThrow('S3 down');
    expect(h.storageGate.release).toHaveBeenCalledTimes(1);
    await h.svc.removeDocument(AUTH, 'e1', 'd1', 'r');
    expect(h.storageGate.release).toHaveBeenLastCalledWith('t1', 'esign/source/t1/e1/obj');
  });
});

describe('AtsPlanEligibilityAdapter', () => {
  const caps = new Map<string, Set<string>>([
    ['ats-tenant', new Set(['core', 'ats', 'esign'])],
    ['sign-only', new Set(['core', 'esign'])],
    ['suspended-ats', new Set(['core', 'ats', 'esign'])],
  ]);
  const status: Record<string, string> = { 'ats-tenant': 'ACTIVE', 'sign-only': 'ACTIVE', 'suspended-ats': 'SUSPENDED' };
  const adapter = new AtsPlanEligibilityAdapter(
    { getCapabilities: vi.fn(async (t: string) => caps.get(t) ?? new Set()) } as unknown as EntitlementRepository,
    { findById: vi.fn(async (t: string) => (status[t] === undefined ? null : { id: t, status: status[t] })) } as unknown as TenantRepository,
  );
  const ON = { SIGN_PROFESSIONAL_ELIGIBILITY: 'ATS_ENTITLEMENT' };

  it('is OFF until the qualifying rule is confirmed: nobody is eligible by default', async () => {
    expect(await adapter.isEligible('ats-tenant', 'ATS_SUBSCRIPTION', {})).toBe(false);
    expect(await adapter.isEligible('ats-tenant', 'ATS_SUBSCRIPTION', { SIGN_PROFESSIONAL_ELIGIBILITY: 'yes' })).toBe(false);
  });

  it('with the confirmed rule: the live ats entitlement on an ACTIVE tenant; unknown rules never pass', async () => {
    expect(await adapter.isEligible('ats-tenant', 'ATS_SUBSCRIPTION', ON)).toBe(true);
    expect(await adapter.isEligible('sign-only', 'ATS_SUBSCRIPTION', ON)).toBe(false);
    expect(await adapter.isEligible('suspended-ats', 'ATS_SUBSCRIPTION', ON)).toBe(false);
    expect(await adapter.isEligible('missing', 'ATS_SUBSCRIPTION', ON)).toBe(false);
    expect(await adapter.isEligible('ats-tenant', 'SOMETHING' as never, ON)).toBe(false);
  });
});
