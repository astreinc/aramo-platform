export { TalentModule } from './lib/talent.module.js';
export { TalentService } from './lib/talent.service.js';
export { TalentRepository } from './lib/talent.repository.js';
export type {
  CreateTalentInput,
  CreateTalentTenantOverlayInput,
} from './lib/talent.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export type { TalentDto, TalentTenantOverlayDto } from './lib/dto/index.js';
