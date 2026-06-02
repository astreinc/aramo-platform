export { PipelineModule } from './lib/pipeline.module.js';
export { PipelineController } from './lib/pipeline.controller.js';
export { PipelineRepository } from './lib/pipeline.repository.js';
export { PrismaService as PipelinePrismaService } from './lib/prisma/prisma.service.js';

export {
  PIPELINE_STATUS_VALUES,
  isPipelineStatus,
  canTransition,
  legalNextStates,
  type PipelineStatus,
} from './lib/pipeline-state.js';

export {
  type PipelineView,
  type PipelineStatusHistoryView,
  type CreatePipelineRequestDto,
  type TransitionPipelineRequestDto,
} from './lib/dto/index.js';
