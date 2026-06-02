export { AttachmentModule } from './lib/attachment.module.js';
export { AttachmentController } from './lib/attachment.controller.js';
export { AttachmentRepository } from './lib/attachment.repository.js';
export { PrismaService as AttachmentPrismaService } from './lib/prisma/prisma.service.js';

export {
  ATTACHMENT_OWNER_TYPES,
  isAttachmentOwnerType,
  type AttachmentOwnerType,
  type AttachmentView,
  type CreateAttachmentRequestDto,
} from './lib/dto/index.js';
