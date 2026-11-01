import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import { normalizeBrandColor, normalizeDisplayName, validateBrandingLogo } from './branding-validation.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — the tenant's stored branding
// (sign."SignTenantBranding", one row per tenant). Storage only: whether branding is APPLIED
// (feature availability + plan entitlement) is decided by the sign-service branding service.

export interface StoredBranding {
  tenant_id: string;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo: StoredBrandingLogo | null;
  updated_at: Date;
  updated_by: string;
}

export interface StoredBrandingLogo {
  logo_id: string;
  content_type: 'image/png' | 'image/jpeg';
  sha256: string;
  byte_size: number;
  width: number;
  height: number;
}

export interface BrandingLogoBytes extends StoredBrandingLogo {
  tenant_id: string;
  bytes: Uint8Array;
}

export interface BrandingSettingsInput {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
}

type Row = {
  tenant_id: string;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo_id: string | null;
  logo_content_type: string | null;
  logo_sha256: string | null;
  logo_byte_size: number | null;
  logo_width: number | null;
  logo_height: number | null;
  updated_at: Date;
  updated_by: string;
};

// The row without the logo bytes (reads that do not serve the image never load them).
const META_SELECT = {
  tenant_id: true,
  display_name: true,
  primary_color: true,
  accent_color: true,
  logo_id: true,
  logo_content_type: true,
  logo_sha256: true,
  logo_byte_size: true,
  logo_width: true,
  logo_height: true,
  updated_at: true,
  updated_by: true,
} as const;

function logoOf(r: Row): StoredBrandingLogo | null {
  if (r.logo_id === null || r.logo_content_type === null || r.logo_sha256 === null || r.logo_byte_size === null || r.logo_width === null || r.logo_height === null) return null;
  if (r.logo_content_type !== 'image/png' && r.logo_content_type !== 'image/jpeg') return null;
  return { logo_id: r.logo_id, content_type: r.logo_content_type, sha256: r.logo_sha256, byte_size: r.logo_byte_size, width: r.logo_width, height: r.logo_height };
}

function toStored(r: Row): StoredBranding {
  return {
    tenant_id: r.tenant_id,
    display_name: r.display_name,
    primary_color: r.primary_color,
    accent_color: r.accent_color,
    logo: logoOf(r),
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  };
}

const NO_LOGO = {
  logo_id: null,
  logo_bytes: null,
  logo_content_type: null,
  logo_sha256: null,
  logo_byte_size: null,
  logo_width: null,
  logo_height: null,
} as const;

@Injectable()
export class SignBrandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenant_id: string): Promise<StoredBranding | null> {
    const row = await this.prisma.signTenantBranding.findUnique({ where: { tenant_id }, select: META_SELECT });
    return row === null ? null : toStored(row);
  }

  /** Display name and colours (each null = the Aramo default). The logo is unchanged. */
  async setSettings(tenant_id: string, input: BrandingSettingsInput, actor_user_id: string): Promise<StoredBranding> {
    const data = {
      display_name: input.display_name === null ? null : normalizeDisplayName(input.display_name),
      primary_color: input.primary_color === null ? null : normalizeBrandColor(input.primary_color),
      accent_color: input.accent_color === null ? null : normalizeBrandColor(input.accent_color),
    };
    if ((input.display_name !== null && data.display_name === null) || (input.primary_color !== null && data.primary_color === null) || (input.accent_color !== null && data.accent_color === null)) {
      throw new RangeError('invalid branding settings');
    }
    const now = new Date();
    const row = await this.prisma.signTenantBranding.upsert({
      where: { tenant_id },
      create: { tenant_id, ...data, updated_by: actor_user_id, updated_at: now },
      update: { ...data, updated_by: actor_user_id, updated_at: now },
      select: META_SELECT,
    });
    return toStored(row);
  }

  /** Replaces the logo. A new logo_id is minted every time, so an old address stops working. */
  async setLogo(tenant_id: string, bytes: Uint8Array, content_type: string, actor_user_id: string): Promise<StoredBranding> {
    const checked = validateBrandingLogo(bytes, content_type);
    if (!checked.ok) throw new RangeError(checked.reason);
    const logo = {
      logo_id: randomUUID(),
      logo_bytes: Buffer.from(bytes),
      logo_content_type: checked.image.content_type,
      logo_sha256: createHash('sha256').update(bytes).digest('hex'),
      logo_byte_size: bytes.byteLength,
      logo_width: checked.image.width,
      logo_height: checked.image.height,
    };
    const now = new Date();
    const row = await this.prisma.signTenantBranding.upsert({
      where: { tenant_id },
      create: { tenant_id, ...logo, updated_by: actor_user_id, updated_at: now },
      update: { ...logo, updated_by: actor_user_id, updated_at: now },
      select: META_SELECT,
    });
    return toStored(row);
  }

  async clearLogo(tenant_id: string, actor_user_id: string): Promise<StoredBranding | null> {
    const existing = await this.prisma.signTenantBranding.findUnique({ where: { tenant_id }, select: { tenant_id: true } });
    if (existing === null) return null;
    const row = await this.prisma.signTenantBranding.update({
      where: { tenant_id },
      data: { ...NO_LOGO, updated_by: actor_user_id, updated_at: new Date() },
      select: META_SELECT,
    });
    return toStored(row);
  }

  /** The logo bytes by their public id (any tenant), or null. */
  async logoById(logo_id: string): Promise<BrandingLogoBytes | null> {
    const row = await this.prisma.signTenantBranding.findUnique({ where: { logo_id }, select: { ...META_SELECT, logo_bytes: true } });
    if (row === null || row.logo_bytes === null) return null;
    const logo = logoOf(row);
    return logo === null ? null : { ...logo, tenant_id: row.tenant_id, bytes: new Uint8Array(row.logo_bytes) };
  }

  /** The tenant's current logo bytes, or null. */
  async logoOfTenant(tenant_id: string): Promise<BrandingLogoBytes | null> {
    const row = await this.prisma.signTenantBranding.findUnique({ where: { tenant_id }, select: { ...META_SELECT, logo_bytes: true } });
    if (row === null || row.logo_bytes === null) return null;
    const logo = logoOf(row);
    return logo === null ? null : { ...logo, tenant_id: row.tenant_id, bytes: new Uint8Array(row.logo_bytes) };
  }
}
