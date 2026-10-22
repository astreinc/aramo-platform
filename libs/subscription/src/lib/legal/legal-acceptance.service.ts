import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import type { LegalDocumentVersion } from './legal-documents.js';

// Commercial Plans Amendment A1 §3 — acceptance evidence for signup (checkout
// writes its own inside the checkout transaction). Records the exact document
// version and text hash; idempotent per (document, version, context, context_ref).
@Injectable()
export class LegalAcceptanceService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    document: LegalDocumentVersion;
    context: 'SIGNUP' | 'CHECKOUT';
    context_ref: string;
    tenant_id: string | null;
    user_id: string | null;
    subject_email: string | null;
    accepted_at: Date;
  }): Promise<void> {
    const existing = await this.prisma.legalAcceptance.findFirst({
      where: { document_key: input.document.key, version: input.document.version, context: input.context, context_ref: input.context_ref },
    });
    if (existing !== null) return;
    await this.prisma.legalAcceptance.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        subject_email: input.subject_email,
        document_key: input.document.key,
        version: input.document.version,
        sha256: input.document.sha256,
        context: input.context,
        context_ref: input.context_ref,
        accepted_at: input.accepted_at,
      },
    });
  }

  /**
   * Aramo Sign Personal (Free) — the (document, version, sha256) a user has accepted
   * in a tenant, in any context (signup or in-app). Read by the Sign workspace's
   * legal status to find documents whose current APPROVED version is not accepted.
   */
  async acceptedBy(input: { tenant_id: string; user_id: string; keys: readonly string[] }): Promise<{ document_key: string; version: string; sha256: string }[]> {
    if (input.keys.length === 0) return [];
    return this.prisma.legalAcceptance.findMany({
      where: { tenant_id: input.tenant_id, user_id: input.user_id, document_key: { in: [...input.keys] } },
      select: { document_key: true, version: true, sha256: true },
    });
  }

  /**
   * Aramo Sign Personal (Free) — a signed-in user accepts the current APPROVED
   * version in the workspace (context IN_APP). One acceptance per user, tenant,
   * document and version (idempotent); its origin (IP, user agent) is written in
   * the same transaction.
   */
  async recordInApp(input: {
    document: LegalDocumentVersion;
    tenant_id: string;
    user_id: string;
    subject_email: string | null;
    ip: string | null;
    user_agent: string | null;
    accepted_at: Date;
  }): Promise<'RECORDED' | 'ALREADY'> {
    const context_ref = inAppContextRef(input.tenant_id, input.user_id);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.legalAcceptance.findFirst({
        where: { document_key: input.document.key, version: input.document.version, context: 'IN_APP', context_ref },
      });
      if (existing !== null) return 'ALREADY' as const;
      const id = uuidv7();
      await tx.legalAcceptance.create({
        data: {
          id,
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          subject_email: input.subject_email,
          document_key: input.document.key,
          version: input.document.version,
          sha256: input.document.sha256,
          context: 'IN_APP',
          context_ref,
          accepted_at: input.accepted_at,
        },
      });
      await tx.legalAcceptanceOrigin.create({
        data: { acceptance_id: id, ip: clip(input.ip, 64), user_agent: clip(input.user_agent, 512) },
      });
      return 'RECORDED' as const;
    });
  }
}

/** The context_ref of an IN_APP acceptance: one per tenant and user. */
export function inAppContextRef(tenant_id: string, user_id: string): string {
  return `in_app:${tenant_id}:${user_id}`;
}

function clip(v: string | null, max: number): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}
