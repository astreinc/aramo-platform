// A typed error for contract violations the engine REJECTS: an unregistered
// resource or action in the context (§D5), or a package that references an
// unregistered effect kind or is otherwise malformed. This is a programming /
// authoring fault (a caller passed an identifier outside the declared
// allowlist), NOT an HTTP concern — the engine is a pure library and carries no
// status codes. The owning service maps this to a response at its boundary.
export type PolicyEngineErrorCode =
  | 'UNREGISTERED_RESOURCE'
  | 'UNREGISTERED_ACTION'
  | 'UNREGISTERED_EFFECT'
  | 'MALFORMED_RULE'
  | 'MISSING_DEFAULT_DISPOSITION'
  | 'EMPTY_COMPOSITION';

export class PolicyEngineError extends Error {
  readonly code: PolicyEngineErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: PolicyEngineErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PolicyEngineError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
