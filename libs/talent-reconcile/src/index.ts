export { TalentReconcileModule } from './lib/talent-reconcile.module.js';
export {
  TalentReconcileService,
  type ReconcileOutcome,
  type ReconcileResult,
} from './lib/talent-reconcile.service.js';
export {
  TalentReconcileProcessor,
  type TalentReconcileTickInput,
} from './lib/talent-reconcile.processor.js';
export {
  computeReconcilePlan,
  type ReconcilePlan,
} from './lib/reconcile-plan.js';
export {
  TALENT_RECONCILE_QUEUE_NAME,
  TALENT_RECONCILE_BATCH_SIZE,
  TALENT_RECONCILE_MAX_ATTEMPTS,
  TALENT_RECONCILE_ACTOR,
} from './lib/talent-reconcile.queue.constants.js';
export {
  ContradictionDetectionService,
  type ContradictionOutcome,
  type ContradictionResult,
} from './lib/contradiction-detection.service.js';
export {
  ContradictionDetectionProcessor,
  type ContradictionDetectionTickInput,
} from './lib/contradiction-detection.processor.js';
export {
  CONTRADICTION_DETECTION_QUEUE_NAME,
  CONTRADICTION_DETECTION_BATCH_SIZE,
} from './lib/contradiction-detection.queue.constants.js';
