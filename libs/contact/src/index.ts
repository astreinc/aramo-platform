export { ContactModule } from './lib/contact.module.js';
export { ContactController } from './lib/contact.controller.js';
export { ContactRepository } from './lib/contact.repository.js';
export { PrismaService as ContactPrismaService } from './lib/prisma/prisma.service.js';

export type {
  ContactView,
  CreateContactRequestDto,
  UpdateContactRequestDto,
  ContactSortKey,
  SortDir,
  ContactFacetBucket,
  ContactFacets,
  ContactSearchQuery,
  ContactSearchPage,
  RelationshipRole,
  ContactPreference,
} from './lib/dto/index.js';
export {
  QUIET_DAYS,
  RELATIONSHIP_ROLE_VALUES,
  PREFERENCE_VALUES,
  assertContactVocab,
} from './lib/dto/index.js';
