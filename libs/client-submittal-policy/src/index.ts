// Public barrel — libs/client-submittal-policy (CSP PR-2). DARK: the domain owns
// resolve / compile / decide + the gateway PORT; there is NO submit-command
// reference yet (that wiring is PR-3).

export {
  CLIENT_SUBMITTAL_REQUIREMENT_KEYS,
  DISPOSITION_VALUES,
  OVERRIDE_CLASS_VALUES,
  OVERRIDE_POLICY_VALUES,
  DEFAULT_OVERRIDE_POLICY,
  isClientSubmittalRequirementKey,
  isDisposition,
  isOverrideClass,
  isOverridePolicy,
  isClientSubmittalRequirement,
  isClientSubmittalPolicyDefinition,
  canonicalizeDefinition,
  checksumDefinition,
} from './lib/client-submittal-vocab.js';
export type {
  ClientSubmittalRequirementKey,
  Disposition,
  OverrideClass,
  OverridePolicy,
  ClientSubmittalRequirement,
  ClientSubmittalPolicyDefinition,
} from './lib/client-submittal-vocab.js';

export {
  floorViolation,
  joinFloor,
  dispositionIsAtLeastAsStrictAs,
  overrideClassIsAtLeastAsStrictAs,
} from './lib/client-submittal-floor.js';
export type { SubmittalFloorDimension } from './lib/client-submittal-floor.js';

export {
  CLIENT_SUBMITTAL_POLICY_GATEWAY,
  CLIENT_SUBMITTAL_POLICY_SCOPES,
  CLIENT_SUBMITTAL_PACKAGE_LIKE,
  clientSubmittalPackageName,
} from './lib/client-submittal-policy.gateway.js';
export type {
  ClientSubmittalPolicyScope,
  ClientSubmittalPolicyGateway,
  StoredPolicyVersionRow,
  InsertClientSubmittalVersionInput,
} from './lib/client-submittal-policy.gateway.js';

export {
  CLIENT_SUBMITTAL_PACKAGE_NAME,
  CLIENT_SUBMITTAL_RESOURCE,
  CLIENT_SUBMITTAL_ACTION,
  CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY,
  compileEffectivePackage,
} from './lib/client-submittal-compiler.js';

export { ClientSubmittalPolicyService } from './lib/client-submittal-policy.service.js';
export type {
  ClientSubmittalScopeContext,
  EffectiveLayerRef,
  ResolvedClientSubmittalPolicy,
  RequirementSourceRef,
  RequirementProvenance,
  EffectiveRequirementView,
  EffectivePolicyView,
  PolicyLayerView,
  PolicyLayersView,
  PolicyVersionHistoryEntry,
} from './lib/client-submittal-policy.service.js';
