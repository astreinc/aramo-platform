import type { PolicyPackage } from '@aramo/policy-engine';

// The public data shapes of policy-store. The stored `definition` is a
// PolicyPackage — the first-class contract owned by libs/policy-engine
// (ADR-0024 §D7). This is the sole cross-lib dependency: a TYPE-only import,
// policy-store -> policy-engine (never the reverse; the engine stays a
// dependency-free leaf).

/** Input to publish a new immutable version of a policy package. */
export interface PublishPolicyVersionInput {
  readonly tenant_id: string;
  /** The policy package to store. `name` and `version` are read from it. */
  readonly definition: PolicyPackage;
  /** Actor (UUID) publishing this version. */
  readonly published_by: string;
  /**
   * Inclusive start of this version's activity window. Must be strictly
   * after the current open version's effective_from (if any). Defaults to
   * "now" when omitted.
   */
  readonly effective_from?: Date;
}

/**
 * A resolved, integrity-verified policy version. `definition` is the typed
 * PolicyPackage; the caller (the engine, in a later PR) evaluates it —
 * policy-store never does.
 */
export interface ResolvedPolicyVersion {
  readonly tenant_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly definition: PolicyPackage;
  readonly checksum: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly published_by: string;
  readonly published_at: Date;
}
