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

  async createTenant(args: { id: string; name: string }): Promise<TenantDto> {
    const row = await this.prisma.tenant.create({
      data: { id: args.id, name: args.name },
    });
    return toTenantDto(row);
  }

  async deactivateTenant(args: { id: string }): Promise<void> {
    await this.prisma.tenant.update({
      where: { id: args.id },
      data: { is_active: false },
    });
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
}

type TenantRow = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
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
  };
}
