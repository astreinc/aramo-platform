import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { DEFAULT_SIGN_DATE_FORMAT, SIGN_DATE_FORMATS, type SignDateFormat } from './domain/sign-date.js';
import { PrismaService } from './prisma/prisma.service.js';

// Aramo Sign Mobile M-A12 §2 W1-E / W1-F — the signed-in user's own Sign data:
//   profile    display name and optional contact details (auto-fill for the
//              FIRST_NAME / LAST_NAME / EMAIL / COMPANY / TITLE field types),
//   settings   the date format stamped on envelopes the user sends, and the
//              default field size,
//   app issues the metadata of reported issues (the rate-limit window; the message
//              is emailed to support and never stored),
//   favorites  the user's favorite templates (markers with an opaque template id: Sign
//              stores no template).
// Owned by exactly one (tenant, user): every read, write and delete is filtered by
// BOTH. All of it is in the M-A8 deletion scope (removeAllForUser) and is counted in
// the privacy inventory.

// Client Rule Consolidation C2-4 — the date format list is the one in @aramo/sign-client.
export { SIGN_DATE_FORMATS, DEFAULT_SIGN_DATE_FORMAT, type SignDateFormat } from './domain/sign-date.js';
export const SIGN_FIELD_SIZES = ['S', 'M', 'L'] as const;
export type SignFieldSize = (typeof SIGN_FIELD_SIZES)[number];
export const DEFAULT_SIGN_FIELD_SIZE: SignFieldSize = 'M';
// SignUserFavorite.item_kind of a favorite template (an opaque Documents template id).
const FAVORITE_TEMPLATE = 'TEMPLATE';

export interface SignUserProfileValue {
  display_name: string;
  title: string | null;
  company: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
}

export interface SignUserProfileRow extends SignUserProfileValue {
  updated_at: Date;
}

export interface SignUserSettingsValue {
  date_format: SignDateFormat;
  default_field_size: SignFieldSize;
  // M-A15 §5 — offer the saved signature on emailed signing links (default true).
  offer_saved_signature_on_links: boolean;
}

// M-A15 §5 — a PUT may leave the new setting out (clients that send only the first two).
export type SignUserSettingsWrite = Omit<SignUserSettingsValue, 'offer_saved_signature_on_links'> & {
  offer_saved_signature_on_links?: boolean;
};

export interface SignUserDataCounts {
  profiles: number;
  settings: number;
  app_issue_reports: number;
  template_favorites: number;
}

// C0-2 — formatSignDate / resolveSignerTimeZone live in the pure domain module (re-exported).
export { formatSignDate, resolveSignerTimeZone, SIGN_DATE_FALLBACK_TIME_ZONE } from './domain/sign-date.js';

@Injectable()
export class SignUserProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Profile ────────────────────────────────────────────────────────────────

  async getProfile(tenant_id: string, user_id: string): Promise<SignUserProfileRow | null> {
    const r = await this.prisma.signUserProfile.findUnique({ where: { tenant_id_user_id: { tenant_id, user_id } } });
    if (r === null) return null;
    return {
      display_name: r.display_name,
      title: r.title,
      company: r.company,
      address_line1: r.address_line1,
      address_line2: r.address_line2,
      city: r.city,
      region: r.region,
      postal_code: r.postal_code,
      country: r.country,
      phone: r.phone,
      updated_at: r.updated_at,
    };
  }

  async putProfile(tenant_id: string, user_id: string, value: SignUserProfileValue): Promise<SignUserProfileRow> {
    const now = new Date();
    const r = await this.prisma.signUserProfile.upsert({
      where: { tenant_id_user_id: { tenant_id, user_id } },
      create: { tenant_id, user_id, ...value, created_at: now, updated_at: now },
      update: { ...value, updated_at: now },
    });
    return { ...value, updated_at: r.updated_at };
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings(tenant_id: string, user_id: string): Promise<SignUserSettingsValue> {
    const r = await this.prisma.signUserSettings.findUnique({ where: { tenant_id_user_id: { tenant_id, user_id } } });
    return {
      date_format: (SIGN_DATE_FORMATS as readonly string[]).includes(r?.date_format ?? '') ? (r?.date_format as SignDateFormat) : DEFAULT_SIGN_DATE_FORMAT,
      default_field_size: (SIGN_FIELD_SIZES as readonly string[]).includes(r?.default_field_size ?? '') ? (r?.default_field_size as SignFieldSize) : DEFAULT_SIGN_FIELD_SIZE,
      offer_saved_signature_on_links: r?.offer_saved_signature_on_links ?? true,
    };
  }

  async putSettings(tenant_id: string, user_id: string, value: SignUserSettingsWrite): Promise<SignUserSettingsValue> {
    const now = new Date();
    // An omitted offer_saved_signature_on_links keeps the stored value (default true).
    const { offer_saved_signature_on_links: offer, ...rest } = value;
    const r = await this.prisma.signUserSettings.upsert({
      where: { tenant_id_user_id: { tenant_id, user_id } },
      create: { tenant_id, user_id, ...rest, ...(offer !== undefined ? { offer_saved_signature_on_links: offer } : {}), created_at: now, updated_at: now },
      update: { ...rest, ...(offer !== undefined ? { offer_saved_signature_on_links: offer } : {}), updated_at: now },
    });
    return { ...rest, offer_saved_signature_on_links: r.offer_saved_signature_on_links };
  }

  // M-A15 §3.3 — whether this user offers their saved signature on emailed links.
  async offersSavedSignatureOnLinks(tenant_id: string, user_id: string): Promise<boolean> {
    const r = await this.prisma.signUserSettings.findUnique({
      where: { tenant_id_user_id: { tenant_id, user_id } },
      select: { offer_saved_signature_on_links: true },
    });
    return r?.offer_saved_signature_on_links ?? true;
  }

  // ── App issues (metadata only) ─────────────────────────────────────────────

  async countAppIssuesSince(tenant_id: string, user_id: string, since: Date): Promise<number> {
    return this.prisma.signAppIssueReport.count({ where: { tenant_id, user_id, created_at: { gte: since } } });
  }

  /** The oldest report inside the window (for Retry-After), or null. */
  async oldestAppIssueSince(tenant_id: string, user_id: string, since: Date): Promise<Date | null> {
    const r = await this.prisma.signAppIssueReport.findFirst({ where: { tenant_id, user_id, created_at: { gte: since } }, orderBy: { created_at: 'asc' }, select: { created_at: true } });
    return r?.created_at ?? null;
  }

  async recordAppIssue(input: { tenant_id: string; user_id: string; os: string; app_version: string; now?: Date }): Promise<string> {
    const id = randomUUID();
    await this.prisma.signAppIssueReport.create({
      data: { id, tenant_id: input.tenant_id, user_id: input.user_id, os: input.os, app_version: input.app_version, created_at: input.now ?? new Date() },
    });
    return id;
  }

  async removeAppIssue(id: string): Promise<void> {
    await this.prisma.signAppIssueReport.deleteMany({ where: { id } });
  }

  // ── Template favorites ─────────────────────────────────────────────────────

  async favoriteTemplateIds(tenant_id: string, user_id: string): Promise<Set<string>> {
    const rows = await this.prisma.signUserFavorite.findMany({ where: { tenant_id, user_id, item_kind: FAVORITE_TEMPLATE }, select: { item_ref: true } });
    return new Set(rows.map((r) => r.item_ref));
  }

  /** Idempotent. */
  async addFavorite(tenant_id: string, user_id: string, template_ref: string): Promise<void> {
    await this.prisma.signUserFavorite.upsert({
      where: { tenant_id_user_id_item_kind_item_ref: { tenant_id, user_id, item_kind: FAVORITE_TEMPLATE, item_ref: template_ref } },
      create: { tenant_id, user_id, item_kind: FAVORITE_TEMPLATE, item_ref: template_ref },
      update: {},
    });
  }

  /** Idempotent. */
  async removeFavorite(tenant_id: string, user_id: string, template_ref: string): Promise<void> {
    await this.prisma.signUserFavorite.deleteMany({ where: { tenant_id, user_id, item_kind: FAVORITE_TEMPLATE, item_ref: template_ref } });
  }

  // ── Deletion scope and inventory (M-A8, privacy requests) ──────────────────

  async countForUser(tenant_id: string, user_id: string): Promise<SignUserDataCounts> {
    const owner = { tenant_id, user_id };
    return {
      profiles: await this.prisma.signUserProfile.count({ where: owner }),
      settings: await this.prisma.signUserSettings.count({ where: owner }),
      app_issue_reports: await this.prisma.signAppIssueReport.count({ where: owner }),
      template_favorites: await this.prisma.signUserFavorite.count({ where: owner }),
    };
  }

  /** Every profile, settings, app-issue and favorite row of this user in this tenant. Idempotent; counts only. */
  async removeAllForUser(tenant_id: string, user_id: string): Promise<SignUserDataCounts> {
    const owner = { tenant_id, user_id };
    return this.prisma.$transaction(async (tx) => ({
      profiles: (await tx.signUserProfile.deleteMany({ where: owner })).count,
      settings: (await tx.signUserSettings.deleteMany({ where: owner })).count,
      app_issue_reports: (await tx.signAppIssueReport.deleteMany({ where: owner })).count,
      template_favorites: (await tx.signUserFavorite.deleteMany({ where: owner })).count,
    }));
  }
}
