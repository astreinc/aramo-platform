export { ContactModule } from './lib/contact.module.js';
export { ContactController } from './lib/contact.controller.js';
export { ContactRepository } from './lib/contact.repository.js';
export { PrismaService as ContactPrismaService } from './lib/prisma/prisma.service.js';
export type { ContactSearchRow } from './lib/contact.repository.js';

export {
  CONTACT_AUDIT_SINK,
  CONTACT_OWNER_VALIDATOR,
  type ContactAuditSink,
  type ContactOwnerValidator,
} from './lib/contact-owner-validator.port.js';
export { CreateContactRequestDto, UpdateContactRequestDto } from './lib/dto/index.js';
export type {
  ContactView,
  ContactSortKey,
  SortDir,
  ContactFacetBucket,
  ContactFacets,
  ContactSearchQuery,
  ContactSearchPage,
  RelationshipRole,
  ContactPreference,
  ContactKind,
} from './lib/dto/index.js';
export {
  QUIET_DAYS,
  RELATIONSHIP_ROLE_VALUES,
  PREFERENCE_VALUES,
  CONTACT_KIND_VALUES,
  assertContactVocab,
} from './lib/dto/index.js';
