import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { generateSigningToken } from './signing-token.js';

// Sign Unified Product S-7 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.6, mandatory refinement B) — persistence
// for recipient bindings and the recipient-only access they allow. Every read is
// keyed by the AUTHENTICATED user id: a binding never reaches another user, and
// nothing here lists or reads the sender tenant's envelopes.

// Inbox signing sessions are short: the user asked to sign now.
export const RECIPIENT_SESSION_TTL_MS = 30 * 60 * 1000;
// Inbox signed-copy links are short as well (the emailed one keeps its own TTL).
export const RECIPIENT_COPY_TTL_MS = 10 * 60 * 1000;

export interface RecipientInboxRow {
  id: string;
  envelope_tenant_id: string;
  envelope_id: string;
  signer_id: string;
  created_at: Date;
  envelope: { subject: string; status: string; sent_at: Date | null; completed_at: Date | null; expires_at: Date | null };
  signer: { name: string; status: string; signed_at: Date | null };
}

@Injectable()
export class RecipientInboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The live session (if any) behind a raw signing token, with its recipient.
  async sessionForToken(token_hash: string): Promise<{ tenant_id: string; envelope_id: string; signer_id: string; status: string; expires_at: Date; signer_email: string } | null> {
    const s = await this.prisma.signingSession.findUnique({
      where: { token_hash },
      select: { tenant_id: true, envelope_id: true, signer_id: true, status: true, expires_at: true, signer: { select: { email: true } } },
    });
    return s === null ? null : { tenant_id: s.tenant_id, envelope_id: s.envelope_id, signer_id: s.signer_id, status: s.status, expires_at: s.expires_at, signer_email: s.signer.email };
  }

  async bind(input: { envelope_tenant_id: string; envelope_id: string; signer_id: string; user_id: string; user_tenant_id: string; email: string }): Promise<{ id: string }> {
    return this.prisma.signRecipientBinding.upsert({
      where: { signer_id_user_id: { signer_id: input.signer_id, user_id: input.user_id } },
      create: { id: randomUUID(), ...input },
      update: { revoked_at: null },
      select: { id: true },
    });
  }

  listForUser(user_id: string): Promise<RecipientInboxRow[]> {
    return this.prisma.signRecipientBinding.findMany({
      where: { user_id, revoked_at: null },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        envelope_tenant_id: true,
        envelope_id: true,
        signer_id: true,
        created_at: true,
        envelope: { select: { subject: true, status: true, sent_at: true, completed_at: true, expires_at: true } },
        signer: { select: { name: true, status: true, signed_at: true } },
      },
    });
  }

  getForUser(user_id: string, id: string): Promise<RecipientInboxRow | null> {
    return this.prisma.signRecipientBinding.findFirst({
      where: { id, user_id, revoked_at: null },
      select: {
        id: true,
        envelope_tenant_id: true,
        envelope_id: true,
        signer_id: true,
        created_at: true,
        envelope: { select: { subject: true, status: true, sent_at: true, completed_at: true, expires_at: true } },
        signer: { select: { name: true, status: true, signed_at: true } },
      },
    });
  }

  async revoke(user_id: string, id: string): Promise<boolean> {
    const r = await this.prisma.signRecipientBinding.updateMany({ where: { id, user_id, revoked_at: null }, data: { revoked_at: new Date() } });
    return r.count > 0;
  }

  // A NEW, short-lived signing session for this recipient. It never revokes the
  // emailed link's session (that stays independently valid), and the ledger
  // records that the recipient opened it from their Aramo inbox.
  async issueRecipientSession(tenant_id: string, envelope_id: string, signer_id: string): Promise<string> {
    const minted = generateSigningToken();
    await this.prisma.$transaction(async (tx) => {
      await tx.signingSession.create({
        data: { id: randomUUID(), tenant_id, envelope_id, signer_id, token_hash: minted.hash, status: 'ISSUED', expires_at: new Date(Date.now() + RECIPIENT_SESSION_TTL_MS) },
      });
    });
    return minted.raw;
  }

  async issueRecipientCopyAccess(tenant_id: string, envelope_id: string, signer_id: string): Promise<string> {
    const minted = generateSigningToken();
    await this.prisma.executedAccessGrant.create({
      data: { id: randomUUID(), tenant_id, envelope_id, signer_id, token_hash: minted.hash, expires_at: new Date(Date.now() + RECIPIENT_COPY_TTL_MS) },
    });
    return minted.raw;
  }
}
