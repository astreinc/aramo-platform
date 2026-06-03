import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';

import type { ContactView } from './dto/contact.view.js';
import type { CreateContactRequestDto } from './dto/create-contact-request.dto.js';
import type { UpdateContactRequestDto } from './dto/update-contact-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// ContactRepository — write + read surface for Contact. Reference-CRUD
// per Ruling 7 (no metering, no event log, no state machine).
//
// Cross-lib edge: contact -> company (the contact -> company leaf-import
// per Ruling 1). At create + update we validate company_id resolves
// within the caller's tenant via CompanyRepository.findById. The reverse
// (company -> contact for billing_contact_id) is NOT a typed link —
// resolved at read-time via UUID only — preserving the no-cycle invariant.

interface ContactRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  company_id: string;
  company_department_id: string | null;
  first_name: string;
  last_name: string;
  title: string | null;
  email1: string | null;
  email2: string | null;
  phone_work: string | null;
  phone_cell: string | null;
  phone_other: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  is_hot: boolean;
  notes: string | null;
  left_company: boolean;
  reports_to_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: ContactRow): ContactView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    company_id: row.company_id,
    company_department_id: row.company_department_id,
    first_name: row.first_name,
    last_name: row.last_name,
    title: row.title,
    email1: row.email1,
    email2: row.email2,
    phone_work: row.phone_work,
    phone_cell: row.phone_cell,
    phone_other: row.phone_other,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    is_hot: row.is_hot,
    notes: row.notes,
    left_company: row.left_company,
    reports_to_id: row.reports_to_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class ContactRepository {
  private readonly logger = new Logger(ContactRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly companyRepository: CompanyRepository,
  ) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateContactRequestDto;
    requestId: string;
  }): Promise<ContactView> {
    // Cross-schema company_id validation — same tenant (Architecture §7.2).
    // Logical UUID resolution; no FK constraint at the DB layer (§7.3).
    const parent = await this.companyRepository.findById({
      tenant_id: args.tenant_id,
      id: args.input.company_id,
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { company_id: args.input.company_id },
        },
      );
    }

    const row = await this.prisma.contact.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        company_id: args.input.company_id,
        company_department_id: args.input.company_department_id ?? null,
        first_name: args.input.first_name,
        last_name: args.input.last_name,
        title: args.input.title ?? null,
        email1: args.input.email1 ?? null,
        email2: args.input.email2 ?? null,
        phone_work: args.input.phone_work ?? null,
        phone_cell: args.input.phone_cell ?? null,
        phone_other: args.input.phone_other ?? null,
        address: args.input.address ?? null,
        address2: args.input.address2 ?? null,
        city: args.input.city ?? null,
        state: args.input.state ?? null,
        zip: args.input.zip ?? null,
        is_hot: args.input.is_hot ?? false,
        notes: args.input.notes ?? null,
        reports_to_id: args.input.reports_to_id ?? null,
        owner_id: args.input.owner_id ?? args.entered_by_id,
        entered_by_id: args.entered_by_id,
      },
    });
    return projectView(row as ContactRow);
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ContactView | null> {
    const row = await this.prisma.contact.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as ContactRow);
  }

  async list(args: {
    tenant_id: string;
    company_id?: string;
    site_id?: string;
    limit?: number;
  }): Promise<ContactView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.contact.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.company_id === undefined ? {} : { company_id: args.company_id }),
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as ContactRow[]).map(projectView);
  }

  // PR-A7 — tenant-scoped count for the reporting aggregator.
  async count(args: {
    tenant_id: string;
    site_id?: string;
  }): Promise<number> {
    return this.prisma.contact.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
    });
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateContactRequestDto;
    requestId: string;
  }): Promise<ContactView> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const row = await this.prisma.contact.update({
      where: { id: args.id },
      data: {
        ...(args.input.company_department_id === undefined ? {} : { company_department_id: args.input.company_department_id }),
        ...(args.input.first_name === undefined ? {} : { first_name: args.input.first_name }),
        ...(args.input.last_name === undefined ? {} : { last_name: args.input.last_name }),
        ...(args.input.title === undefined ? {} : { title: args.input.title }),
        ...(args.input.email1 === undefined ? {} : { email1: args.input.email1 }),
        ...(args.input.email2 === undefined ? {} : { email2: args.input.email2 }),
        ...(args.input.phone_work === undefined ? {} : { phone_work: args.input.phone_work }),
        ...(args.input.phone_cell === undefined ? {} : { phone_cell: args.input.phone_cell }),
        ...(args.input.phone_other === undefined ? {} : { phone_other: args.input.phone_other }),
        ...(args.input.address === undefined ? {} : { address: args.input.address }),
        ...(args.input.address2 === undefined ? {} : { address2: args.input.address2 }),
        ...(args.input.city === undefined ? {} : { city: args.input.city }),
        ...(args.input.state === undefined ? {} : { state: args.input.state }),
        ...(args.input.zip === undefined ? {} : { zip: args.input.zip }),
        ...(args.input.is_hot === undefined ? {} : { is_hot: args.input.is_hot }),
        ...(args.input.notes === undefined ? {} : { notes: args.input.notes }),
        ...(args.input.left_company === undefined ? {} : { left_company: args.input.left_company }),
        ...(args.input.reports_to_id === undefined ? {} : { reports_to_id: args.input.reports_to_id }),
        ...(args.input.owner_id === undefined ? {} : { owner_id: args.input.owner_id }),
      },
    });
    return projectView(row as ContactRow);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.contact.delete({ where: { id: args.id } });
  }
}
