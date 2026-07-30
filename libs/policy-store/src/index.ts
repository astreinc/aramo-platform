// @aramo/policy-store — persistence, versioning, publication, tenant
// retrieval and caching for policy packages (ADR-0024 §D7 / §D17b). The
// stateless evaluator is @aramo/policy-engine; this library never evaluates
// a policy. No NestJS module/controller/endpoint and no consumers yet — a
// later PR wires it.

export { PolicyStore } from './lib/policy-store.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export { PolicyStoreError } from './lib/errors.js';
export type { PolicyStoreErrorCode } from './lib/errors.js';

export type { PublishPolicyVersionInput, ResolvedPolicyVersion } from './lib/types.js';

export { canonicalSerialize, computeChecksum, checksumMatches } from './lib/checksum.js';
export { isEffectiveAt, selectEffectiveAt } from './lib/window.js';
export type { EffectiveWindow } from './lib/window.js';

// Decision provenance (ADR-0024 §D17a) — append-only write API.
export { PolicyDecisionRecordStore } from './lib/decision-record-store.js';
export type {
  RecordPolicyDecisionInput,
  PolicyDecisionRecord,
} from './lib/decision-record-store.js';
export { snapshotPolicyInputs } from './lib/decision-inputs.js';
export type { PolicyDecisionInputs } from './lib/decision-inputs.js';
