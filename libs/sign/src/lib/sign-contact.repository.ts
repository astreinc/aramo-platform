import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Aramo Sign Mobile (M-A3 §5 / §9) — a sender's private contacts. Owned by exactly
// one (tenant, owner user): every read, write and delete is filtered by BOTH, so
// nothing is shared across users or tenants. A contact gives no authority:
// recipients are still validated when the envelope is sent.

export interface SignContactRow {
  id: string;
  name: string;
  email: string;
  organization: string | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

export function contactEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

// The owner already has a contact with this email.
export class SignContactDuplicateError extends Error {
  constructor() {
    super('A contact with this email already exists');
    this.name = 'SignContactDuplicateError';
  }
}

const SELECT = { id: true, name: true, email: true, organization: true, created_at: true, updated_at: true, last_used_at: true } as const;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class SignContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(tenant_id: string, owner_user_id: string, limit = 500): Promise<SignContactRow[]> {
    return this.prisma.signContact.findMany({
      where: { tenant_id, owner_user_id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit,
      select: SELECT,
    });
  }

  async create(tenant_id: string, owner_user_id: string, input: { name: string; email: string; organization: string | null }): Promise<SignContactRow> {
    const now = new Date();
    try {
      return await this.prisma.signContact.create({
        data: { id: randomUUID(), tenant_id, owner_user_id, name: input.name, email: input.email.trim(), email_key: contactEmailKey(input.email), organization: input.organization, created_at: now, updated_at: now },
        select: SELECT,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new SignContactDuplicateError();
      throw e;
    }
  }

  // null when the contact is not the caller's (no oracle across users/tenants).
  async update(
    tenant_id: string,
    owner_user_id: string,
    id: string,
    patch: { name?: string; email?: string; organization?: string | null },
  ): Promise<SignContactRow | null> {
    const own = await this.prisma.signContact.findFirst({ where: { id, tenant_id, owner_user_id }, select: { id: true } });
    if (own === null) return null;
    try {
      return await this.prisma.signContact.update({
        where: { id: own.id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.email !== undefined ? { email: patch.email.trim(), email_key: contactEmailKey(patch.email) } : {}),
          ...(patch.organization !== undefined ? { organization: patch.organization } : {}),
          updated_at: new Date(),
        },
        select: SELECT,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new SignContactDuplicateError();
      throw e;
    }
  }

  async remove(tenant_id: string, owner_user_id: string, id: string): Promise<boolean> {
    const r = await this.prisma.signContact.deleteMany({ where: { id, tenant_id, owner_user_id } });
    return r.count > 0;
  }

  // After a send — the owner's contacts for these recipients were just used.
  async touchUsed(tenant_id: string, owner_user_id: string, emails: readonly string[], at: Date = new Date()): Promise<void> {
    if (emails.length === 0) return;
    await this.prisma.signContact.updateMany({
      where: { tenant_id, owner_user_id, email_key: { in: emails.map(contactEmailKey) } },
      data: { last_used_at: at },
    });
  }

  // Account close (M-A3 §9) — every contact this user owns in this tenant.
  async removeAllForUser(tenant_id: string, owner_user_id: string): Promise<number> {
    const r = await this.prisma.signContact.deleteMany({ where: { tenant_id, owner_user_id } });
    return r.count;
  }
}
