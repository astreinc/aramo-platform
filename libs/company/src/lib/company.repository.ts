import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CompanyView } from './dto/company.view.js';
import type { CreateCompanyRequestDto } from './dto/create-company-request.dto.js';
import type { UpdateCompanyRequestDto } from './dto/update-company-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// CompanyRepository — write + read surface for Company. Reference-CRUD
// per Ruling 7 (no metering, no event log, no state machine).
//
// Every method scopes by tenant_id (Architecture §7.2). site_id is the
// caller's responsibility at the controller layer: the route's
// @RequireSiteMatch + the JWT site claim govern axis enforcement; the
// repository writes the site_id verbatim and trusts the controller.

interface CompanyRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  name: string;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone1: string | null;
  phone2: string | null;
  fax_number: string | null;
  url: string | null;
  key_technologies: string | null;
  notes: string | null;
  is_hot: boolean;
  billing_contact_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    name: row.name,
    address: row.address,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone1: row.phone1,
    phone2: row.phone2,
    fax_number: row.fax_number,
    url: row.url,
    key_technologies: row.key_technologies,
    notes: row.notes,
    is_hot: row.is_hot,
    billing_contact_id: row.billing_contact_id,
    owner_id: row.owner_id,
    entered_by_id: row.entered_by_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class CompanyRepository {
  private readonly logger = new Logger(CompanyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    entered_by_id: string;
    input: CreateCompanyRequestDto;
  }): Promise<CompanyView> {
    const { tenant_id, entered_by_id, input } = args;
    const row = await this.prisma.company.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        name: input.name,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        phone1: input.phone1 ?? null,
        phone2: input.phone2 ?? null,
        fax_number: input.fax_number ?? null,
        url: input.url ?? null,
        key_technologies: input.key_technologies ?? null,
        notes: input.notes ?? null,
        is_hot: input.is_hot ?? false,
        billing_contact_id: input.billing_contact_id ?? null,
        owner_id: input.owner_id ?? entered_by_id,
        entered_by_id,
      },
    });
    return projectView(row as CompanyRow);
  }

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<CompanyView | null> {
    const row = await this.prisma.company.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as CompanyRow);
  }

  async list(args: {
    tenant_id: string;
    site_id?: string;
    limit?: number;
  }): Promise<CompanyView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.company.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as CompanyRow[]).map(projectView);
  }

  async update(args: {
    tenant_id: string;
    id: string;
    input: UpdateCompanyRequestDto;
    requestId: string;
  }): Promise<CompanyView> {
    const existing = await this.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const row = await this.prisma.company.update({
      where: { id: args.id },
      data: {
        ...(args.input.name === undefined ? {} : { name: args.input.name }),
        ...(args.input.address === undefined ? {} : { address: args.input.address }),
        ...(args.input.address2 === undefined ? {} : { address2: args.input.address2 }),
        ...(args.input.city === undefined ? {} : { city: args.input.city }),
        ...(args.input.state === undefined ? {} : { state: args.input.state }),
        ...(args.input.zip === undefined ? {} : { zip: args.input.zip }),
        ...(args.input.phone1 === undefined ? {} : { phone1: args.input.phone1 }),
        ...(args.input.phone2 === undefined ? {} : { phone2: args.input.phone2 }),
        ...(args.input.fax_number === undefined ? {} : { fax_number: args.input.fax_number }),
        ...(args.input.url === undefined ? {} : { url: args.input.url }),
        ...(args.input.key_technologies === undefined ? {} : { key_technologies: args.input.key_technologies }),
        ...(args.input.notes === undefined ? {} : { notes: args.input.notes }),
        ...(args.input.is_hot === undefined ? {} : { is_hot: args.input.is_hot }),
        ...(args.input.billing_contact_id === undefined ? {} : { billing_contact_id: args.input.billing_contact_id }),
        ...(args.input.owner_id === undefined ? {} : { owner_id: args.input.owner_id }),
      },
    });
    return projectView(row as CompanyRow);
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
        'Company not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.company.delete({ where: { id: args.id } });
  }
}
