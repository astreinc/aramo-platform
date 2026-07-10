import { Injectable } from '@nestjs/common';

import type { TenantDto } from './dto/tenant.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for Tenant reads + (AUTHZ-2) the platform-tier create surface.
// Per §7 TenantService.getTenantsByUser, callers want tenants the user has an
// *active* membership in AND the tenant itself is active. Filtering happens
// database-side via the relation predicate.
//
// AUTHZ-2: createTenant is the guarded write surface invoked by
// TenantService.provisionTenant (the platform-tier saga, Lead ruling 6).
// Idempotent-by-name is REJECTED here (TENANT_ALREADY_EXISTS at the service
// layer); the repository writes a row or surfaces the unique-constraint
// failure for the service to map.
//
// Soft-disable on cross-schema-saga failure (Lead ruling 7): the existing
// soft-disable surface (`deactivateTenant`) is reused; it flips is_active=
// false rather than deleting the row. The Cognito user + identity records
// stay durable; the tenant becomes inert (the EntitlementGuard blocks all
// capability access on the empty entitlement set, and the JwtAuthGuard
// /SessionOrchestrator refuse to issue tokens against an inactive tenant).
@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveTenantsForUser(args: { user_id: string }): Promise<TenantDto[]> {
    const rows = await this.prisma.tenant.findMany({
      where: {
        is_active: true,
        memberships: {
          some: {
            user_id: args.user_id,
            is_active: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toTenantDto);
  }

  async findByNameCaseInsensitive(name: string): Promise<TenantDto | null> {
    const row = await this.prisma.tenant.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    return row === null ? null : toTenantDto(row);
  }

  // Subdomain-Identity Directive A — the cert-eligibility lookup. Returns the
  // tenant that owns this subdomain slug AND is active, or null. Both conditions
  // are in the WHERE so a single indexed query (slug is @unique) answers "is
  // <slug>.aramo.ai a real, active tenant?" — the question the public ask-
  // endpoint asks before Caddy issues an on-demand cert. Slug is stored
  // normalized (lowercase); the caller passes a lowercased host label, so this
  // is an exact match. A disabled tenant (is_active=false) is NOT eligible — its
  // subdomain stops getting new certs (existing ones in Caddy's store persist).
  async findActiveBySlug(slug: string): Promise<TenantDto | null> {
    const row = await this.prisma.tenant.findFirst({
      // Platform-Console Increment-2 PR-1 (workstream F, R11): cert-eligibility
      // refuses a CLOSED tenant but REMAINS satisfied for SUSPENDED (a suspended
      // tenant's UX must still render over TLS). The is_active predicate stays
      // during migration (ADD-not-rename). SUSPENDED/PROVISIONED/OFFBOARDING/
      // ACTIVE all keep their subdomain cert; only CLOSED loses it.
      where: { slug, is_active: true, status: { not: 'CLOSED' } },
    });
    return row === null ? null : toTenantDto(row);
  }

  // Domain-Enforcement P1 — allowed_domain is set at creation by
  // TenantService.provisionTenant (derived from the owner's non-personal
  // email domain, stored normalized). Optional so legacy/test callers that
  // do not supply it leave it NULL (the invite domain-lock then allows
  // through — see TenantUserLifecycleService.inviteTenantUser).
  async createTenant(args: {
    id: string;
    name: string;
    allowed_domain?: string | null;
    // Subdomain-Identity Directive A — the validated subdomain slug (DNS-safe,
    // lowercased by deriveSlugOrThrow upstream). Optional so legacy/test callers
    // that do not supply it leave it NULL (no subdomain; the ask-endpoint 404s
    // for that tenant until a slug is set).
    slug?: string | null;
  }): Promise<TenantDto> {
    const row = await this.prisma.tenant.create({
      data: {
        id: args.id,
        name: args.name,
        allowed_domain: args.allowed_domain ?? null,
        slug: args.slug ?? null,
      },
    });
    return toTenantDto(row);
  }

  async deactivateTenant(args: { id: string }): Promise<void> {
    await this.prisma.tenant.update({
      where: { id: args.id },
      data: { is_active: false },
    });
  }

  // Platform-Console Increment-2 PR-1.5 (Workstream A1) — the platform-operator
  // tenant list. DELIBERATELY UNGATED: no membership predicate and no is_active
  // predicate — an operator must see EVERY tenant in EVERY status (a suspended
  // tenant must be MORE visible to an operator, not less). This is the exact
  // inverse of findActiveTenantsForUser (the session-mint read, which stays
  // byte-untouched): that answers "which live tenants can THIS user act in";
  // this answers "show me the whole estate". Optional filters: exact `status`
  // and `q` (case-insensitive contains on name OR slug). Ordered created_at desc.
  // No pagination yet (single-digit tenant counts) — the controller wraps the
  // rows in a `{ tenants: [...] }` envelope so pagination metadata can be added
  // later without a breaking shape change.
  async listAllTenants(args: {
    status?: string;
    q?: string;
  }): Promise<PlatformTenantListRow[]> {
    const where: Record<string, unknown> = {};
    if (args.status !== undefined && args.status.length > 0) {
      where['status'] = args.status;
    }
    if (args.q !== undefined && args.q.length > 0) {
      where['OR'] = [
        { name: { contains: args.q, mode: 'insensitive' } },
        { slug: { contains: args.q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.tenant.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        status_reason_code: true,
        status_changed_at: true,
        is_active: true,
        created_at: true,
        activated_at: true,
        suspended_at: true,
      },
    });
    return rows.map(toPlatformTenantListRow);
  }

  // Platform-Console Increment-2 PR-1 — single-tenant read for the platform
  // console detail endpoint (GET /platform/tenants/:id). Returns null for an
  // unknown id (controller maps to NOT_FOUND).
  async findById(id: string): Promise<TenantDto | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row === null ? null : toTenantDto(row);
  }

  // Platform-Console Increment-2 PR-1 — the lifecycle status read used by the
  // transition service to load the current state before validating a transition.
  // Returns null for an unknown tenant (caller maps to NOT_FOUND).
  async findLifecycleById(
    id: string,
  ): Promise<{ id: string; status: string; is_active: boolean } | null> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, status: true, is_active: true },
    });
    return row === null ? null : row;
  }

  // Platform-Console Increment-2 PR-1 — the lifecycle status write. Sets status +
  // status_changed_at + reason columns + whatever milestone/retention columns the
  // caller computed for this transition. Transition legality is enforced by the
  // TenantService (this is the persistence step only).
  async updateStatus(
    id: string,
    patch: {
      status: string;
      status_reason_code: string | null;
      status_reason_text: string | null;
      status_changed_at: Date;
      owner_accepted_at?: Date;
      activated_at?: Date;
      suspended_at?: Date;
      offboarding_started_at?: Date;
      closed_at?: Date;
      retention_policy_code?: string | null;
      retention_delete_after?: Date | null;
    },
  ): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: patch });
  }

  // Settings Rebuild Directive 3 — tenant-profile read/update. tenant_id is
  // always the caller's own (pinned from the JWT at the controller); there is
  // no cross-tenant path. Returns null for a missing/unknown tenant.
  async findProfileById(id: string): Promise<TenantProfileRow | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row === null ? null : toProfileRow(row);
  }

  async updateProfile(
    id: string,
    patch: Record<string, string | null>,
  ): Promise<TenantProfileRow> {
    const row = await this.prisma.tenant.update({ where: { id }, data: patch });
    return toProfileRow(row);
  }

  // Domain-Enforcement P2b — the DNS-verification read. tenant_id is always the
  // caller's own (pinned from the JWT at the controller); no cross-tenant path.
  // Returns null for a missing/unknown tenant. allowed_domain (the P1 column) is
  // carried alongside the verification state because the record-to-publish is
  // derived from it.
  async findDomainVerificationById(
    id: string,
  ): Promise<DomainVerificationRow | null> {
    const row = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        allowed_domain: true,
        domain_verification_status: true,
        domain_verification_token: true,
        domain_verified_at: true,
        domain_token_issued_at: true,
      },
    });
    return row === null ? null : row;
  }

  // Domain-Enforcement P2b — the DNS-verification write (mint token → PENDING;
  // check match → VERIFIED). Only the verification columns are touched.
  async updateDomainVerification(
    id: string,
    patch: {
      domain_verification_status?: string;
      domain_verification_token?: string | null;
      domain_verified_at?: Date | null;
      domain_token_issued_at?: Date | null;
    },
  ): Promise<DomainVerificationRow> {
    const row = await this.prisma.tenant.update({
      where: { id },
      data: patch,
      select: {
        id: true,
        allowed_domain: true,
        domain_verification_status: true,
        domain_verification_token: true,
        domain_verified_at: true,
        domain_token_issued_at: true,
      },
    });
    return row;
  }
}

export interface DomainVerificationRow {
  id: string;
  allowed_domain: string | null;
  domain_verification_status: string;
  domain_verification_token: string | null;
  domain_verified_at: Date | null;
  domain_token_issued_at: Date | null;
}

// Platform-Console Increment-2 PR-1.5 (A1) — the platform-operator list row.
// Distinct from TenantDto: it carries the lifecycle-snapshot columns an operator
// needs to triage the estate (status + reason + the activated/suspended
// milestones) and the slug, but NOT the profile/domain fields. Capability
// summary stays on the detail endpoint (PR-1), not the list. Timestamps are
// serialized to ISO strings at the repository boundary (the DTO convention).
export interface PlatformTenantListRow {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  status_reason_code: string | null;
  status_changed_at: string;
  is_active: boolean;
  created_at: string;
  activated_at: string | null;
  suspended_at: string | null;
}

function toPlatformTenantListRow(row: {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  status_reason_code: string | null;
  status_changed_at: Date;
  is_active: boolean;
  created_at: Date;
  activated_at: Date | null;
  suspended_at: Date | null;
}): PlatformTenantListRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    status_reason_code: row.status_reason_code,
    status_changed_at: row.status_changed_at.toISOString(),
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    activated_at: row.activated_at === null ? null : row.activated_at.toISOString(),
    suspended_at: row.suspended_at === null ? null : row.suspended_at.toISOString(),
  };
}

type TenantRow = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  // Subdomain-Identity Directive B — carried so findActiveBySlug surfaces it to
  // the login redirect for Home Realm Discovery.
  identity_provider: string | null;
  // Platform-Console Increment-2 PR-1 — the lifecycle status.
  status: string;
};

export interface TenantProfileRow {
  id: string;
  name: string;
  legal_name: string | null;
  display_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
  tax_id: string | null;
  registration_number: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  logo_url: string | null;
  updated_at: Date;
}

function toProfileRow(row: {
  id: string;
  name: string;
  legal_name: string | null;
  display_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
  tax_id: string | null;
  registration_number: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  logo_url: string | null;
  updated_at: Date;
}): TenantProfileRow {
  return {
    id: row.id,
    name: row.name,
    legal_name: row.legal_name,
    display_name: row.display_name,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state_province: row.state_province,
    postal_code: row.postal_code,
    country_code: row.country_code,
    tax_id: row.tax_id,
    registration_number: row.registration_number,
    primary_contact_name: row.primary_contact_name,
    primary_contact_email: row.primary_contact_email,
    primary_contact_phone: row.primary_contact_phone,
    logo_url: row.logo_url,
    updated_at: row.updated_at,
  };
}

function toTenantDto(row: TenantRow): TenantDto {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    identity_provider: row.identity_provider,
    status: row.status,
  };
}
