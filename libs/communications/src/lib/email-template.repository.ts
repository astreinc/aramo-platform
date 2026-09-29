import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// D-EMAIL-TPL-1 (ET-2) — reusable tenant email-template store (communications
// domain). Tenant-scoped by construction: every query carries tenant_id in the
// WHERE, so a cross-tenant row is structurally invisible. Storage is D-1 Option
// C: a tenant with NO active row for a template_key is a cache miss, and the
// caller falls back to the code-owned system default. This repository is the
// DEFINITION store only — the FINAL sent subject/body remain the system of record
// on CommunicationInteraction.

export const EMAIL_TEMPLATE_CATEGORIES = ['requisition_initial_contact'] as const;
export type EmailTemplateCategory = (typeof EMAIL_TEMPLATE_CATEGORIES)[number];

export interface EmailTemplateRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly template_key: string;
  readonly category: EmailTemplateCategory;
  readonly name: string;
  readonly subject_template: string;
  readonly body_template: string;
  readonly is_active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RawRow {
  id: string;
  tenant_id: string;
  template_key: string;
  category: string;
  name: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toRow(r: RawRow): EmailTemplateRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    template_key: r.template_key,
    category: r.category as EmailTemplateCategory,
    name: r.name,
    subject_template: r.subject_template,
    body_template: r.body_template,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

@Injectable()
export class EmailTemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The tenant's active override for a logical key, or NULL when the tenant has
   * none (→ caller uses the code-owned system default, D-1 Option C). tenant_id
   * is in the WHERE, so another tenant's row is never returned.
   */
  async findActiveByKey(tenant_id: string, template_key: string): Promise<EmailTemplateRow | null> {
    const row = await this.prisma.emailTemplate.findFirst({
      where: { tenant_id, template_key, is_active: true },
    });
    return row === null ? null : toRow(row);
  }

  /** All templates owned by the tenant (active + deactivated), for the admin list. */
  async listByTenant(tenant_id: string): Promise<EmailTemplateRow[]> {
    const rows = await this.prisma.emailTemplate.findMany({
      where: { tenant_id },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toRow);
  }

  /** Tenant-scoped single fetch — NULL if the id belongs to another tenant. */
  async findByIdForTenant(tenant_id: string, id: string): Promise<EmailTemplateRow | null> {
    const row = await this.prisma.emailTemplate.findFirst({ where: { tenant_id, id } });
    return row === null ? null : toRow(row);
  }

  async create(args: {
    tenant_id: string;
    template_key: string;
    category: EmailTemplateCategory;
    name: string;
    subject_template: string;
    body_template: string;
    created_by_id: string | null;
  }): Promise<EmailTemplateRow> {
    const row = await this.prisma.emailTemplate.create({
      data: {
        tenant_id: args.tenant_id,
        template_key: args.template_key,
        category: args.category,
        name: args.name,
        subject_template: args.subject_template,
        body_template: args.body_template,
        created_by_id: args.created_by_id,
        updated_by_id: args.created_by_id,
      },
    });
    return toRow(row);
  }

  /** Tenant-scoped update. The WHERE carries tenant_id, so a caller can never
   *  mutate another tenant's row — a cross-tenant id matches 0 rows → null. */
  async update(
    tenant_id: string,
    id: string,
    patch: {
      name?: string;
      subject_template?: string;
      body_template?: string;
      updated_by_id: string | null;
    },
  ): Promise<EmailTemplateRow | null> {
    const data: Record<string, unknown> = { updated_by_id: patch.updated_by_id };
    if (patch.name !== undefined) data['name'] = patch.name;
    if (patch.subject_template !== undefined) data['subject_template'] = patch.subject_template;
    if (patch.body_template !== undefined) data['body_template'] = patch.body_template;
    const res = await this.prisma.emailTemplate.updateMany({ where: { id, tenant_id }, data });
    if (res.count === 0) return null; // not found OR another tenant's row
    return this.findByIdForTenant(tenant_id, id);
  }

  /** Tenant-scoped soft-deactivate → the tenant falls back to the code default.
   *  Returns false when the id is unknown or belongs to another tenant. */
  async deactivate(tenant_id: string, id: string, actor_id: string | null): Promise<boolean> {
    const res = await this.prisma.emailTemplate.updateMany({
      where: { id, tenant_id },
      data: { is_active: false, updated_by_id: actor_id },
    });
    return res.count > 0;
  }
}
