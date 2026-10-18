import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// The provider integration layer's store (Multi-Provider directive §D/§E).

export const SIGNATURE_PROVIDERS = ['aramo_sign', 'docusign', 'adobe_sign'] as const;
export type SignatureProviderKey = (typeof SIGNATURE_PROVIDERS)[number];
/** The built-in provider, used when a tenant has made no selection. */
export const DEFAULT_SIGNATURE_PROVIDER: SignatureProviderKey = 'aramo_sign';

export function isSignatureProvider(v: unknown): v is SignatureProviderKey {
  return typeof v === 'string' && (SIGNATURE_PROVIDERS as readonly string[]).includes(v);
}

export interface SignatureRoute {
  readonly provider: SignatureProviderKey;
  readonly provider_envelope_ref: string;
  readonly created_at: Date;
}

@Injectable()
export class SignatureRoutingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getSelectedProvider(tenant_id: string): Promise<{ provider: SignatureProviderKey; explicit: boolean }> {
    const row = await this.prisma.tenantSignatureProvider.findUnique({ where: { tenant_id } });
    if (row === null || !isSignatureProvider(row.provider)) return { provider: DEFAULT_SIGNATURE_PROVIDER, explicit: false };
    return { provider: row.provider, explicit: true };
  }

  /** Explicit, audited change of the tenant's provider. Existing requests keep their own route. */
  async selectProvider(input: { tenant_id: string; provider: SignatureProviderKey; actor_id: string }): Promise<{ from: SignatureProviderKey; to: SignatureProviderKey; changed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.tenantSignatureProvider.findUnique({ where: { tenant_id: input.tenant_id } });
      const from = current !== null && isSignatureProvider(current.provider) ? current.provider : DEFAULT_SIGNATURE_PROVIDER;
      if (current !== null && from === input.provider) return { from, to: input.provider, changed: false };
      await tx.tenantSignatureProvider.upsert({
        where: { tenant_id: input.tenant_id },
        create: { tenant_id: input.tenant_id, provider: input.provider, selected_by: input.actor_id },
        update: { provider: input.provider, selected_by: input.actor_id, selected_at: new Date() },
      });
      await tx.signatureProviderSelectionEvent.create({
        data: { id: uuidv7(), tenant_id: input.tenant_id, from_provider: from, to_provider: input.provider, actor_id: input.actor_id },
      });
      return { from, to: input.provider, changed: from !== input.provider };
    });
  }

  async listSelectionEvents(tenant_id: string): Promise<{ from_provider: string; to_provider: string; actor_id: string; occurred_at: Date }[]> {
    return this.prisma.signatureProviderSelectionEvent.findMany({
      where: { tenant_id },
      orderBy: { occurred_at: 'asc' },
      select: { from_provider: true, to_provider: true, actor_id: true, occurred_at: true },
    });
  }

  /** Freeze the provider on a created request. Idempotent per provider envelope. */
  async recordRoute(input: { tenant_id: string; document_id: string; document_revision_id: string; provider: SignatureProviderKey; provider_envelope_ref: string }): Promise<void> {
    await this.prisma.signatureRequestRoute.createMany({ data: [{ id: uuidv7(), ...input }], skipDuplicates: true });
  }

  /** The most recent route for a document revision, or null when none was recorded. */
  async findRoute(tenant_id: string, document_id: string, document_revision_id: string): Promise<SignatureRoute | null> {
    const row = await this.prisma.signatureRequestRoute.findFirst({
      where: { tenant_id, document_id, document_revision_id },
      orderBy: { created_at: 'desc' },
    });
    if (row === null || !isSignatureProvider(row.provider)) return null;
    return { provider: row.provider, provider_envelope_ref: row.provider_envelope_ref, created_at: row.created_at };
  }
}
