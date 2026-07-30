// Typed error surface for policy-store. Mirrors the libs/policy-engine
// PolicyEngineError shape (a discriminated `code` on a single class) so a
// consumer handles both libraries' failures uniformly.

export type PolicyStoreErrorCode =
  // A publish carried a package that fails the engine's shape validation
  // (validatePackage) — e.g. no default_disposition, or a malformed rule. The
  // package is rejected before any write; the message carries the engine's
  // rejection reason.
  | 'INVALID_PACKAGE'
  // The stored definition's recomputed checksum does not match the persisted
  // checksum — the row was tampered with (§D17b integrity guard).
  | 'CHECKSUM_MISMATCH'
  // A publish carried a version string that already exists for this
  // (tenant, package). A published version is immutable; a change must carry
  // a new version string.
  | 'VERSION_ALREADY_EXISTS'
  // A publish carried an effective_from that is not strictly after the
  // current open version's effective_from, which would create an overlapping
  // or out-of-order window.
  | 'INVALID_EFFECTIVE_FROM';

export class PolicyStoreError extends Error {
  readonly code: PolicyStoreErrorCode;

  constructor(code: PolicyStoreErrorCode, message: string) {
    super(message);
    this.name = 'PolicyStoreError';
    this.code = code;
    Object.setPrototypeOf(this, PolicyStoreError.prototype);
  }
}
