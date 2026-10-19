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
