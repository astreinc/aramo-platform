import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — a user's own folders for envelopes. Owned by exactly one
// (tenant, user): every read, write and delete is filtered by BOTH. What a folder holds:
//   SENDER     an envelope id (the service checks the owner can see it first),
//   RECIPIENT  the owner's own signer id (the service resolves it from their inbox item).
// An item is in at most one of the owner's folders: `place` removes it from the others in the
// same transaction. Deleting a folder removes its items (FK cascade), never an envelope.
// All of it is in the M-A8 deletion scope (SignUserProfileRepository.removeAllForUser).

export type SignFolderItemKind = 'SENDER' | 'RECIPIENT';

export interface SignUserFolderRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  sender_items: number;
  recipient_items: number;
}

/** The (lower-cased) name is already one of the owner's folders. */
export class SignFolderNameTakenError extends Error {
  constructor() {
    super('folder name taken');
    this.name = 'SignFolderNameTakenError';
  }
}

const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && ((e as { code?: unknown }).code === UNIQUE_VIOLATION || /SignUserFolder_owner_name_key|unique constraint/i.test(String((e as { message?: unknown }).message ?? '')));
}

@Injectable()
export class SignUserFolderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant_id: string, owner_user_id: string): Promise<SignUserFolderRow[]> {
    const rows = await this.prisma.signUserFolder.findMany({
      where: { tenant_id, owner_user_id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, created_at: true, updated_at: true, items: { select: { item_kind: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
      sender_items: r.items.filter((i) => i.item_kind === 'SENDER').length,
      recipient_items: r.items.filter((i) => i.item_kind === 'RECIPIENT').length,
    }));
  }

  async count(tenant_id: string, owner_user_id: string): Promise<number> {
    return this.prisma.signUserFolder.count({ where: { tenant_id, owner_user_id } });
  }

  /** The owner's folder, or null (another user's folder reads as absent). */
  async find(tenant_id: string, owner_user_id: string, id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.signUserFolder.findFirst({ where: { id, tenant_id, owner_user_id }, select: { id: true, name: true } });
  }

  /** Throws SignFolderNameTakenError on a duplicate name (without case). */
  async create(tenant_id: string, owner_user_id: string, name: string): Promise<{ id: string }> {
    const id = randomUUID();
    try {
      await this.prisma.signUserFolder.create({ data: { id, tenant_id, owner_user_id, name } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new SignFolderNameTakenError();
      throw e;
    }
    return { id };
  }

  /** False when the folder is not the owner's. Throws SignFolderNameTakenError on a duplicate name. */
  async rename(tenant_id: string, owner_user_id: string, id: string, name: string): Promise<boolean> {
    try {
      const r = await this.prisma.signUserFolder.updateMany({ where: { id, tenant_id, owner_user_id }, data: { name, updated_at: new Date() } });
      return r.count > 0;
    } catch (e) {
      if (isUniqueViolation(e)) throw new SignFolderNameTakenError();
      throw e;
    }
  }

  /** Removes the folder and what it holds (never an envelope). False when not the owner's. */
  async remove(tenant_id: string, owner_user_id: string, id: string): Promise<boolean> {
    const r = await this.prisma.signUserFolder.deleteMany({ where: { id, tenant_id, owner_user_id } });
    return r.count > 0;
  }

  /** item_ref → folder id, for every item of this kind in the owner's folders. */
  async placements(tenant_id: string, owner_user_id: string, item_kind: SignFolderItemKind): Promise<Map<string, string>> {
    const rows = await this.prisma.signUserFolderItem.findMany({
      where: { item_kind, folder: { tenant_id, owner_user_id } },
      select: { item_ref: true, folder_id: true },
    });
    return new Map(rows.map((r) => [r.item_ref, r.folder_id]));
  }

  /** The item refs of this kind in one of the owner's folders (empty when not theirs). */
  async itemRefs(tenant_id: string, owner_user_id: string, folder_id: string, item_kind: SignFolderItemKind): Promise<string[]> {
    const rows = await this.prisma.signUserFolderItem.findMany({
      where: { folder_id, item_kind, folder: { tenant_id, owner_user_id } },
      select: { item_ref: true },
    });
    return rows.map((r) => r.item_ref);
  }

  /** Puts the item in this folder and takes it out of the owner's other folders. False when the folder is not the owner's. */
  async place(tenant_id: string, owner_user_id: string, folder_id: string, item_kind: SignFolderItemKind, item_ref: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const folder = await tx.signUserFolder.findFirst({ where: { id: folder_id, tenant_id, owner_user_id }, select: { id: true } });
      if (folder === null) return false;
      await tx.signUserFolderItem.deleteMany({ where: { item_kind, item_ref, folder_id: { not: folder_id }, folder: { tenant_id, owner_user_id } } });
      await tx.signUserFolderItem.upsert({
        where: { folder_id_item_kind_item_ref: { folder_id, item_kind, item_ref } },
        create: { folder_id, item_kind, item_ref },
        update: {},
      });
      return true;
    });
  }

  /** Takes the item out of whichever of the owner's folders holds it. Idempotent. */
  async unplace(tenant_id: string, owner_user_id: string, item_kind: SignFolderItemKind, item_ref: string): Promise<void> {
    await this.prisma.signUserFolderItem.deleteMany({ where: { item_kind, item_ref, folder: { tenant_id, owner_user_id } } });
  }
}
