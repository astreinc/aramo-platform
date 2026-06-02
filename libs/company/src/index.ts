export { CompanyModule } from './lib/company.module.js';
export { CompanyController } from './lib/company.controller.js';
export { CompanyRepository } from './lib/company.repository.js';
export { CompanyDepartmentRepository } from './lib/company-department.repository.js';
export { PrismaService as CompanyPrismaService } from './lib/prisma/prisma.service.js';

export type {
  CompanyView,
  CreateCompanyRequestDto,
  UpdateCompanyRequestDto,
  CompanyDepartmentView,
  CreateCompanyDepartmentRequestDto,
  UpdateCompanyDepartmentRequestDto,
} from './lib/dto/index.js';
