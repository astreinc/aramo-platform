import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { recordUsage } from '@aramo/metering';
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

  /** The request a provider envelope belongs to (used to route provider callbacks). */
  async findRouteByEnvelope(
    provider: SignatureProviderKey,
    provider_envelope_ref: string,
  ): Promise<{ tenant_id: string; document_id: string; document_revision_id: string } | null> {
    return this.prisma.signatureRequestRoute.findFirst({
      where: { provider, provider_envelope_ref },
      select: { tenant_id: true, document_id: true, document_revision_id: true },
    });
  }

  /** Operational usage of an external provider (its own plan governs the quota). */
  async recordExternalSend(tenant_id: string, provider: SignatureProviderKey): Promise<void> {
    await recordUsage(this.prisma, { tenant_id, event_type: `esign.external.envelope.sent.${provider}` });
  }

  /** Start an OAuth connect: returns the opaque state value for the authorize URL. */
  async createOAuthState(input: { tenant_id: string; user_id: string; provider: SignatureProviderKey; code_verifier: string; ttl_ms: number }): Promise<{ state: string }> {
    const state = randomBytes(32).toString('base64url');
    await this.prisma.providerOAuthState.create({
      data: {
        state_hash: hashState(state),
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        provider: input.provider,
        code_verifier: input.code_verifier,
        expires_at: new Date(Date.now() + input.ttl_ms),
      },
    });
    return { state };
  }

  /**
   * Consume a state exactly once, only for the same tenant, user and provider, and
   * only before it expires. Returns the PKCE verifier, or null (never says why).
   */
  async consumeOAuthState(input: { state: string; tenant_id: string; user_id: string; provider: SignatureProviderKey }): Promise<{ code_verifier: string } | null> {
    const rows = await this.prisma.$queryRaw<{ code_verifier: string }[]>`
      UPDATE "signature_routing"."ProviderOAuthState"
         SET consumed_at = now()
       WHERE state_hash = ${hashState(input.state)}
         AND tenant_id = ${input.tenant_id}::uuid
         AND user_id = ${input.user_id}
         AND provider = ${input.provider}
         AND consumed_at IS NULL
         AND expires_at > now()
      RETURNING code_verifier`;
    return rows[0] ?? null;
  }
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
