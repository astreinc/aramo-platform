import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Sign Unified Product S-4 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.4) — persistence for the Sign-owned
// application registry, tenant installations, client credentials, narrowing role
// mappings and short-lived access tokens. Every tenant-facing read is keyed by
// tenant_id. Secrets and tokens are only ever stored as digests (the caller
// hashes); this repository never sees a raw secret.

export interface InstallationGrant {
  granted_permissions: string[];
  modes: string[];
  integration_role: string | null;
  role_assertion_enabled: boolean;
}

// Explicit row shapes for the library boundary (callers in apps/esign-service
// compile against these, not the generated client).
export interface SignApplicationRow {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  requested_permissions: string[];
  modes: string[];
  assertable_roles: string[];
  delegation_profile: string[];
  delegation_required_scope: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface SignRoleMappingRow {
  installation_id: string;
  external_role: string;
  sign_role: string;
  created_at: Date;
}
export interface SignInstallationRow {
  id: string;
  tenant_id: string;
  application_id: string;
  status: string;
  granted_permissions: string[];
  modes: string[];
  integration_role: string | null;
  role_assertion_enabled: boolean;
  first_party_auto: boolean;
  approved_by: string | null;
  approved_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface SignCredentialRow {
  id: string;
  application_id: string;
  installation_id: string | null;
  client_id: string;
  secret_hash: string;
  status: string;
  created_by: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
export interface SignAccessTokenRow {
  id: string;
  token_hash: string;
  credential_id: string;
  installation_id: string;
  tenant_id: string;
  mode: string;
  subject_id: string;
  external_actor: string | null;
  external_role: string | null;
  scopes: string[];
  audience: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}
export type InstallationWithApp = SignInstallationRow & { application: SignApplicationRow };
export type InstallationFull = InstallationWithApp & { role_mappings: SignRoleMappingRow[] };
export type InstallationListed = InstallationFull & { credentials: { id: string; client_id: string; created_at: Date; last_used_at: Date | null }[] };

@Injectable()
export class SignIntegrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Applications ───────────────────────────────────────────────────────────
  findApplicationByKey(key: string): Promise<SignApplicationRow | null> {
    return this.prisma.signApplication.findUnique({ where: { key } });
  }

  findApplicationById(id: string): Promise<SignApplicationRow | null> {
    return this.prisma.signApplication.findUnique({ where: { id } });
  }

  listActiveApplications(): Promise<SignApplicationRow[]> {
    return this.prisma.signApplication.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
  }

  createApplication(input: {
    key: string;
    name: string;
    kind: 'FIRST_PARTY' | 'THIRD_PARTY';
    requested_permissions: string[];
    modes: string[];
    assertable_roles: string[];
  }): Promise<SignApplicationRow> {
    return this.prisma.signApplication.create({ data: { id: randomUUID(), ...input } });
  }

  // ── Installations ──────────────────────────────────────────────────────────
  findInstallation(tenant_id: string, application_id: string): Promise<InstallationWithApp | null> {
    return this.prisma.signInstallation.findUnique({
      where: { tenant_id_application_id: { tenant_id, application_id } },
      include: { application: true },
    });
  }

  getInstallation(tenant_id: string, id: string): Promise<InstallationFull | null> {
    return this.prisma.signInstallation.findFirst({ where: { tenant_id, id }, include: { application: true, role_mappings: true } });
  }

  findInstallationById(id: string): Promise<InstallationFull | null> {
    return this.prisma.signInstallation.findUnique({ where: { id }, include: { application: true, role_mappings: true } });
  }

  listInstallations(tenant_id: string): Promise<InstallationListed[]> {
    return this.prisma.signInstallation.findMany({
      where: { tenant_id },
      include: { application: true, role_mappings: true, credentials: { where: { status: 'ACTIVE' }, select: { id: true, client_id: true, created_at: true, last_used_at: true } } },
      orderBy: { created_at: 'asc' },
    });
  }

  // Creates the installation, or re-activates a revoked one with the new grants.
  upsertInstallation(input: { tenant_id: string; application_id: string; approved_by: string | null; first_party_auto: boolean } & InstallationGrant): Promise<InstallationWithApp> {
    const now = new Date();
    const grant = {
      granted_permissions: input.granted_permissions,
      modes: input.modes,
      integration_role: input.integration_role,
      role_assertion_enabled: input.role_assertion_enabled,
    };
    return this.prisma.signInstallation.upsert({
      where: { tenant_id_application_id: { tenant_id: input.tenant_id, application_id: input.application_id } },
      create: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        application_id: input.application_id,
        status: 'ACTIVE',
        ...grant,
        first_party_auto: input.first_party_auto,
        approved_by: input.approved_by,
        approved_at: now,
      },
      update: { status: 'ACTIVE', ...grant, approved_by: input.approved_by, approved_at: now, revoked_at: null, revoked_by: null, updated_at: now },
      include: { application: true },
    });
  }

  // Creates the first-party installation only if none exists (a revoked one stays revoked).
  async createFirstPartyIfAbsent(input: { tenant_id: string; application_id: string; grants: string[]; modes: string[] }): Promise<InstallationWithApp | null> {
    const existing = await this.findInstallation(input.tenant_id, input.application_id);
    if (existing !== null) return existing;
    try {
      return await this.prisma.signInstallation.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          application_id: input.application_id,
          status: 'ACTIVE',
          granted_permissions: input.grants,
          modes: input.modes,
          first_party_auto: true,
        },
        include: { application: true },
      });
    } catch {
      // A concurrent first use created it — read the winner.
      return this.findInstallation(input.tenant_id, input.application_id);
    }
  }

  async updateInstallationGrant(tenant_id: string, id: string, grant: InstallationGrant): Promise<void> {
    await this.prisma.signInstallation.updateMany({ where: { tenant_id, id }, data: { ...grant, updated_at: new Date() } });
  }

  // Revokes the installation, every credential bound to it and every live token
  // it issued, in one transaction.
  async revokeInstallation(tenant_id: string, id: string, revoked_by: string): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.signInstallation.updateMany({
        where: { tenant_id, id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revoked_at: now, revoked_by, updated_at: now },
      });
      if (r.count === 0) return false;
      await tx.signCredential.updateMany({ where: { installation_id: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revoked_at: now } });
      await tx.signAccessToken.updateMany({ where: { installation_id: id, revoked_at: null }, data: { revoked_at: now } });
      return true;
    });
  }

  replaceRoleMappings(installation_id: string, mappings: { external_role: string; sign_role: string }[]): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.signRoleMapping.deleteMany({ where: { installation_id } });
      if (mappings.length > 0) await tx.signRoleMapping.createMany({ data: mappings.map((m) => ({ installation_id, ...m })) });
    });
  }

  // ── Credentials ────────────────────────────────────────────────────────────
  createCredential(input: { application_id: string; installation_id: string | null; client_id: string; secret_hash: string; created_by: string | null; expires_at?: Date | null }): Promise<SignCredentialRow> {
    return this.prisma.signCredential.create({
      data: { id: randomUUID(), ...input, expires_at: input.expires_at ?? null },
    });
  }

  findCredentialByClientId(client_id: string): Promise<(SignCredentialRow & { application: SignApplicationRow }) | null> {
    return this.prisma.signCredential.findUnique({ where: { client_id }, include: { application: true } });
  }

  async touchCredential(id: string): Promise<void> {
    await this.prisma.signCredential.update({ where: { id }, data: { last_used_at: new Date() } });
  }

  // Revokes one credential of the tenant's installation and every live token it issued.
  async revokeCredential(tenant_id: string, installation_id: string, credential_id: string): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const inst = await tx.signInstallation.findFirst({ where: { tenant_id, id: installation_id }, select: { id: true } });
      if (inst === null) return false;
      const r = await tx.signCredential.updateMany({
        where: { id: credential_id, installation_id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revoked_at: now },
      });
      if (r.count === 0) return false;
      await tx.signAccessToken.updateMany({ where: { credential_id, revoked_at: null }, data: { revoked_at: now } });
      return true;
    });
  }

  // Operator revocation by client id: the credential and every live token it issued.
  async revokeCredentialByClientId(client_id: string): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const cred = await tx.signCredential.findUnique({ where: { client_id }, select: { id: true } });
      if (cred === null) return false;
      await tx.signCredential.update({ where: { id: cred.id }, data: { status: 'REVOKED', revoked_at: now } });
      await tx.signAccessToken.updateMany({ where: { credential_id: cred.id, revoked_at: null }, data: { revoked_at: now } });
      return true;
    });
  }

  // ── Access tokens ──────────────────────────────────────────────────────────
  createToken(input: {
    token_hash: string;
    credential_id: string;
    installation_id: string;
    tenant_id: string;
    mode: 'USER' | 'APPLICATION';
    subject_id: string;
    external_actor: string | null;
    external_role: string | null;
    scopes: string[];
    audience: string;
    expires_at: Date;
  }): Promise<SignAccessTokenRow> {
    return this.prisma.signAccessToken.create({ data: { id: randomUUID(), ...input } });
  }

  findTokenByHash(token_hash: string): Promise<(SignAccessTokenRow & { credential: SignCredentialRow; installation: InstallationWithApp }) | null> {
    return this.prisma.signAccessToken.findUnique({
      where: { token_hash },
      include: { credential: true, installation: { include: { application: true } } },
    });
  }
}

// ── Sign Unified Product S-5 — webhook subscriptions and per-subscription delivery ──

export interface SignWebhookSubscriptionRow {
  id: string;
  application_id: string;
  installation_id: string | null;
  tenant_id: string | null;
  target_url: string;
  event_types: string[];
  secret_ciphertext: string;
  status: string;
  internal: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  secret_rotated_at: Date | null;
}

export interface SignWebhookDeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  tenant_id: string;
  envelope_id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

@Injectable()
export class SignWebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  createSubscription(input: {
    application_id: string;
    installation_id: string | null;
    tenant_id: string | null;
    target_url: string;
    event_types: string[];
    secret_ciphertext: string;
    internal: boolean;
    created_by: string | null;
  }): Promise<SignWebhookSubscriptionRow> {
    return this.prisma.signWebhookSubscription.create({ data: { id: randomUUID(), ...input } });
  }

  listForInstallation(tenant_id: string, installation_id: string): Promise<SignWebhookSubscriptionRow[]> {
    return this.prisma.signWebhookSubscription.findMany({ where: { tenant_id, installation_id }, orderBy: { created_at: 'asc' } });
  }

  getForInstallation(tenant_id: string, installation_id: string, id: string): Promise<SignWebhookSubscriptionRow | null> {
    return this.prisma.signWebhookSubscription.findFirst({ where: { tenant_id, installation_id, id } });
  }

  async rotateSecret(id: string, secret_ciphertext: string): Promise<void> {
    const now = new Date();
    await this.prisma.signWebhookSubscription.update({ where: { id }, data: { secret_ciphertext, secret_rotated_at: now, updated_at: now } });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
    await this.prisma.signWebhookSubscription.update({ where: { id }, data: { status, updated_at: new Date() } });
  }

  // The ACTIVE subscriptions that receive an envelope's events: those of the
  // envelope's installation, plus the application-level (first-party) ones of the
  // envelope's source application — never another application's.
  async subscriptionsForEnvelope(tenant_id: string, envelope_id: string): Promise<{ envelope: { source_application: string; installation_id: string | null } | null; subscriptions: SignWebhookSubscriptionRow[] }> {
    const envelope = await this.prisma.signatureEnvelope.findFirst({ where: { tenant_id, id: envelope_id }, select: { source_application: true, installation_id: true } });
    if (envelope === null) return { envelope: null, subscriptions: [] };
    const app = await this.prisma.signApplication.findUnique({ where: { key: envelope.source_application }, select: { id: true, kind: true } });
    const subscriptions = await this.prisma.signWebhookSubscription.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          ...(envelope.installation_id !== null ? [{ installation_id: envelope.installation_id, tenant_id }] : []),
          ...(app !== null && app.kind === 'FIRST_PARTY' ? [{ application_id: app.id, installation_id: null }] : []),
        ],
      },
    });
    // An application-level subscription only covers tenants where the application is installed and ACTIVE.
    if (app !== null && subscriptions.some((s) => s.installation_id === null)) {
      const inst = await this.prisma.signInstallation.findUnique({ where: { tenant_id_application_id: { tenant_id, application_id: app.id } }, select: { status: true } });
      const active = inst !== null && inst.status === 'ACTIVE';
      return { envelope, subscriptions: subscriptions.filter((s) => s.installation_id !== null || active) };
    }
    return { envelope, subscriptions };
  }

  // Idempotent fan-out: one delivery row per (subscription, event).
  async enqueue(rows: { subscription_id: string; event_id: string; tenant_id: string; envelope_id: string; event_type: string; payload: object }[]): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.signWebhookDelivery.createMany({ data: rows.map((r) => ({ id: randomUUID(), ...r })), skipDuplicates: true });
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<(SignWebhookDeliveryRow & { subscription: SignWebhookSubscriptionRow })[]> {
    const due = await this.prisma.signWebhookDelivery.findMany({
      where: { status: 'PENDING', OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      orderBy: { created_at: 'asc' },
      take: limit,
      include: { subscription: true },
    });
    if (due.length === 0) return [];
    await this.prisma.signWebhookDelivery.updateMany({
      where: { id: { in: due.map((d) => d.id) }, status: 'PENDING' },
      data: { next_attempt_at: new Date(now.getTime() + leaseMs) },
    });
    return due;
  }

  async markDelivered(id: string): Promise<void> {
    const now = new Date();
    await this.prisma.signWebhookDelivery.update({ where: { id }, data: { status: 'DELIVERED', delivered_at: now, last_attempt_at: now, attempt_count: { increment: 1 }, last_error_code: null } });
  }

  async markFailed(id: string, error_code: string, next_attempt_at: Date | null): Promise<void> {
    const now = new Date();
    await this.prisma.signWebhookDelivery.update({
      where: { id },
      data: {
        status: next_attempt_at === null ? 'DEAD' : 'PENDING',
        attempt_count: { increment: 1 },
        last_attempt_at: now,
        last_error_code: error_code.slice(0, 64),
        next_attempt_at,
      },
    });
  }
}
