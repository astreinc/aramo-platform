// @aramo/policy-engine — the STATELESS Business Policy Engine (ADR-0024 §D7).
// A domain-agnostic evaluator over data-authored policy packages. No
// persistence, no publication, no tenant lookup, no domain knowledge — those
// live in libs/policy-store (a separate library) and in the consuming domains.

export type {
  Decision,
  EffectKind,
  Effect,
  Origin,
  RequestMetadata,
  ResourceState,
  PolicyContext,
  PredicateSource,
  PredicateOp,
  Predicate,
  Rule,
  PolicyRegistry,
  DefaultDisposition,
  PolicyPackage,
  DecisionProvenance,
  PolicyDecision,
} from './lib/types.js';
export { EFFECT_KINDS, DECISION_PRECEDENCE } from './lib/types.js';

export { PolicyEngineError } from './lib/errors.js';
export type { PolicyEngineErrorCode } from './lib/errors.js';

export {
  validatePackage,
  isRegisteredEffectKind,
  isRegisteredResource,
  isRegisteredAction,
} from './lib/registry.js';

export { conditionHolds } from './lib/predicate.js';

export { evaluate } from './lib/evaluate.js';

export {
  composePolicyDecisions,
  composeWithAuthorization,
} from './lib/compose.js';
export type { AuthorizationVerdict } from './lib/compose.js';
