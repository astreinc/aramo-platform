// Feature-Parity §1.16 / §1.19 (Amendment A1) — domain errors of the QES and e-stamp
// workflows. The sign-service controller maps them onto existing error codes (no new
// codes): a wrong state → ENVELOPE_ILLEGAL_TRANSITION (409), bad input →
// VALIDATION_ERROR (400), no vendor configured → ESIGN_FEATURE_NOT_AVAILABLE (403).

/** The request is not allowed in the current envelope, signer or order state. */
export class RegulatedSigningStateError extends Error {
  constructor(
    public readonly reason: string,
    message = `This step is not allowed now (${reason})`,
  ) {
    super(message);
    this.name = 'RegulatedSigningStateError';
  }
}

/** One or more inputs are invalid. */
export class RegulatedSigningValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
    message = `${field} is invalid (${reason})`,
  ) {
    super(message);
    this.name = 'RegulatedSigningValidationError';
  }
}
