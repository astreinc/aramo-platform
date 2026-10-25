import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Aramo Sign Mobile (M-A3 §4 / §9) — saved signature defaults. User-deletable
// convenience data owned by exactly one (tenant, user): every read, write and
// delete is filtered by BOTH. The value is a convenience only: a signing still
// submits its own value through the fill call (copied into the SignatureField at
// fill time, never referenced), so deleting a saved signature never changes an
// executed or in-progress record.

export type SavedSignatureSlot = 'signature' | 'initials';
export type SavedSignatureKind = 'TYPED' | 'DRAWN';

export interface SavedSignatureValue {
  kind: SavedSignatureKind;
  typed_name: string | null;
  font_key: string | null;
  image_data_url: string;
}

export interface SavedSignatureRow extends SavedSignatureValue {
  slot: SavedSignatureSlot;
  updated_at: Date;
}

@Injectable()
export class SignSavedSignatureRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant_id: string, user_id: string): Promise<SavedSignatureRow[]> {
    const rows = await this.prisma.signSavedSignature.findMany({ where: { tenant_id, user_id } });
    return rows.map((r) => ({
      slot: r.slot as SavedSignatureSlot,
      kind: r.kind as SavedSignatureKind,
      typed_name: r.typed_name,
      font_key: r.font_key,
      image_data_url: r.image_data_url,
      updated_at: r.updated_at,
    }));
  }

  async put(tenant_id: string, user_id: string, slot: SavedSignatureSlot, value: SavedSignatureValue): Promise<void> {
    const now = new Date();
    await this.prisma.signSavedSignature.upsert({
      where: { tenant_id_user_id_slot: { tenant_id, user_id, slot } },
      create: { id: randomUUID(), tenant_id, user_id, slot, ...value, created_at: now, updated_at: now },
      update: { ...value, updated_at: now },
    });
  }

  async remove(tenant_id: string, user_id: string, slot: SavedSignatureSlot): Promise<boolean> {
    const r = await this.prisma.signSavedSignature.deleteMany({ where: { tenant_id, user_id, slot } });
    return r.count > 0;
  }

  // Account close (M-A3 §9) — every saved signature of this user in this tenant.
  async removeAllForUser(tenant_id: string, user_id: string): Promise<number> {
    const r = await this.prisma.signSavedSignature.deleteMany({ where: { tenant_id, user_id } });
    return r.count;
  }
}
