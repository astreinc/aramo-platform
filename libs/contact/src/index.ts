export { ContactModule } from './lib/contact.module.js';
export { ContactController } from './lib/contact.controller.js';
export { ContactRepository } from './lib/contact.repository.js';
export { PrismaService as ContactPrismaService } from './lib/prisma/prisma.service.js';

export type {
  ContactView,
  CreateContactRequestDto,
  UpdateContactRequestDto,
} from './lib/dto/index.js';
