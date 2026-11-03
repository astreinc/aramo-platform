export { CompanyModule } from './lib/company.module.js';
export { CompanyController } from './lib/company.controller.js';
export { CompanyRepository } from './lib/company.repository.js';
export { CompanyDepartmentRepository } from './lib/company-department.repository.js';
// CONTACTS-1 (SD-6) — billing-contact link port; bound by apps/api.
export {
  COMPANY_BILLING_CONTACT_VALIDATOR,
  type CompanyBillingContactValidator,
} from './lib/billing-contact-validator.port.js';
export { PrismaService as CompanyPrismaService } from './lib/prisma/prisma.service.js';
export type { CompanySearchRow } from './lib/company.repository.js';
export {
  CompanyEmbeddingRepository,
  type CompanyEmbeddingWorkItem,
  type CompanyEmbeddingDescriptor,
  type CompanySemanticMatch,
  type CompanySemanticFactsRow,
} from './lib/company-embedding.repository.js';
// AUTHZ-D4b — exported for libs/visibility consumption (the resolver
// reads UserClientAssignment for the Axis-0 direct + Axis-1 transitive-
// reports lookup; reads TeamClientOwnership for the Axis-2 pod→client
// lookup). Repos were exposed as module providers at D4a; explicit
// barrel re-exports added so libs/visibility can inject them.
export { UserClientAssignmentRepository } from './lib/user-client-assignment.repository.js';
export { TeamClientOwnershipRepository } from './lib/team-client-ownership.repository.js';

export type {
  CompanyView,
  CreateCompanyRequestDto,
  UpdateCompanyRequestDto,
  CompanyDepartmentView,
  CreateCompanyDepartmentRequestDto,
  UpdateCompanyDepartmentRequestDto,
} from './lib/dto/index.js';
