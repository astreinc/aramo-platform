import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CompanyDepartmentView } from './dto/company-department.view.js';
import type { CreateCompanyDepartmentRequestDto } from './dto/create-company-department-request.dto.js';
import type { UpdateCompanyDepartmentRequestDto } from './dto/update-company-department-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

interface CompanyDepartmentRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  company_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: CompanyDepartmentRow): CompanyDepartmentView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    company_id: row.company_id,
    name: row.name,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class CompanyDepartmentRepository {
  private readonly logger = new Logger(CompanyDepartmentRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    company_id: string;
    input: CreateCompanyDepartmentRequestDto;
    requestId: string;
  }): Promise<CompanyDepartmentView> {
    // Tenant-scoped parent lookup (defense against cross-tenant company_id
    // injection — the FK alone would not catch a wrong-tenant id).
    const parent = await this.prisma.company.findFirst({
      where: { tenant_id: args.tenant_id, id: args.company_id },
      select: { id: true },
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        { requestId: args.requestId, details: { company_id: args.company_id } },
      );
    }
    const row = await this.prisma.companyDepartment.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        company_id: args.company_id,
        name: args.input.name,
      },
    });
    return projectView(row as CompanyDepartmentRow);
  }

  async list(args: {
    tenant_id: string;
    company_id: string;
  }): Promise<CompanyDepartmentView[]> {
    const rows = await this.prisma.companyDepartment.findMany({
      where: { tenant_id: args.tenant_id, company_id: args.company_id },
      orderBy: { created_at: 'desc' },
    });
    return (rows as CompanyDepartmentRow[]).map(projectView);
  }

  async update(args: {
    tenant_id: string;
    company_id: string;
    id: string;
    input: UpdateCompanyDepartmentRequestDto;
    requestId: string;
  }): Promise<CompanyDepartmentView> {
    const existing = await this.prisma.companyDepartment.findFirst({
      where: {
        tenant_id: args.tenant_id,
        company_id: args.company_id,
        id: args.id,
      },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'CompanyDepartment not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const row = await this.prisma.companyDepartment.update({
      where: { id: args.id },
      data: {
        ...(args.input.name === undefined ? {} : { name: args.input.name }),
      },
    });
    return projectView(row as CompanyDepartmentRow);
  }

  async delete(args: {
    tenant_id: string;
    company_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.prisma.companyDepartment.findFirst({
      where: {
        tenant_id: args.tenant_id,
        company_id: args.company_id,
        id: args.id,
      },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'CompanyDepartment not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.companyDepartment.delete({ where: { id: args.id } });
  }
}
