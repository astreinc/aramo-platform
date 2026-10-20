import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { StorageAccountingPort } from '@aramo/sign';
import { CapacityService, STORAGE_CAPACITY_KEY } from '@aramo/subscription';

// Commercial Plans Amendment A1 — the tenant storage allocation at the upload
// seam ("unlimited signing is not unlimited storage"). Uploads reserve their
// bytes BEFORE the object is written (concurrency-safe, per-tenant lock in the
// ledger) and release them if the write fails or the draft document is
// removed. Signed copies and certificates are measured, never refused.

export function storageRef(source_object_key: string): string {
  return `sign:object:${source_object_key}`;
}

@Injectable()
export class AramoSignStorageGate implements StorageAccountingPort {
  constructor(private readonly capacity: CapacityService) {}

  async reserveUpload(tenant_id: string, source_object_key: string, bytes: number, requestId: string): Promise<void> {
    const r = await this.capacity.reserve({ tenant_id, capacity_key: STORAGE_CAPACITY_KEY, ref: storageRef(source_object_key), quantity: bytes });
    if (r.ok) return;
    if (r.reason === 'NOT_SUBSCRIBED') {
      throw new AramoError('ESIGN_NOT_SUBSCRIBED', 'Uploading documents needs an Aramo Sign plan', 403, { requestId, details: { reason: 'NOT_SUBSCRIBED' } });
    }
    throw new AramoError('ESIGN_STORAGE_QUOTA_EXCEEDED', 'Your organization’s storage is full', 409, {
      requestId,
      details: { reason: 'CAPACITY_EXCEEDED', used: r.status?.used ?? null, limit: r.status?.limit ?? null, requested: bytes },
    });
  }

  async release(tenant_id: string, source_object_key: string): Promise<void> {
    await this.capacity.release({ tenant_id, capacity_key: STORAGE_CAPACITY_KEY, ref: storageRef(source_object_key) });
  }

  async recordKept(input: { tenant_id: string; ref: string; bytes: number }): Promise<void> {
    await this.capacity.reserve({ tenant_id: input.tenant_id, capacity_key: STORAGE_CAPACITY_KEY, ref: input.ref, quantity: input.bytes, enforce: false });
  }
}
