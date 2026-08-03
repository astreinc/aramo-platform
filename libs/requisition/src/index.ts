export { RequisitionModule } from './lib/requisition.module.js';
export { RequisitionController } from './lib/requisition.controller.js';
export {
  RequisitionRepository,
  type PublishableRequisitionRow,
} from './lib/requisition.repository.js';
export { RequisitionAssignmentRepository } from './lib/requisition-assignment.repository.js';
export { PrismaService as RequisitionPrismaService } from './lib/prisma/prisma.service.js';

// ADR-0024 §D17c — append-only lifecycle mutation history (write API only;
// PR-5 wires the consumer).
export {
  RequisitionLifecycleEventStore,
  type RecordRequisitionLifecycleEventInput,
  type RequisitionLifecycleEvent,
  type RequisitionLifecycleOrigin,
} from './lib/requisition-lifecycle-event.store.js';

export {
  RECRUITING_STATUS_VALUES,
  isRecruitingStatus,
  type RecruitingStatus,
  type RequisitionView,
  emptyRequisitionProfileView,
  type RequisitionProfileView,
  type CreateRequisitionRequestDto,
  type UpdateRequisitionRequestDto,
  type RequisitionAssignmentView,
  type AssignRequisitionRequestDto,
  RATE_TYPE_VALUES,
  isRateType,
  type RateType,
  type IntakeDraftRequestDto,
  type IntakeDraftResponseDto,
  type IntakeExtractedFields,
} from './lib/dto/index.js';
