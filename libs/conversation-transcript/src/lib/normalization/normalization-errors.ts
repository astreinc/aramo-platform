// CI-B4 — normalization error taxonomy (directive §error-taxonomy). Lib-local
// (mirrors B3's domain/errors.ts choice — no HTTP surface, so no shared
// error-code registry entry). Every error carries a SAFE taxonomy `code` and a
// `retryable` classification; NONE carry raw parser output or transcript text
// (directive §logging / §28). Provider/parser exceptions are mapped to these.

/** Stable taxonomy tokens persisted to `last_error_code` (never raw text). */
export const NORMALIZATION_ERROR_CODES = {
  SOURCE_ARTIFACT_NOT_FOUND: 'SOURCE_ARTIFACT_NOT_FOUND',
  SOURCE_HASH_MISMATCH: 'SOURCE_HASH_MISMATCH',
  SOURCE_FORMAT_UNSUPPORTED: 'SOURCE_FORMAT_UNSUPPORTED',
  SOURCE_PARSE_FAILED: 'SOURCE_PARSE_FAILED',
  NORMALIZED_ARTIFACT_WRITE_FAILED: 'NORMALIZED_ARTIFACT_WRITE_FAILED',
  NORMALIZATION_SCHEMA_INVALID: 'NORMALIZATION_SCHEMA_INVALID',
} as const;

export type NormalizationErrorCode =
  (typeof NORMALIZATION_ERROR_CODES)[keyof typeof NORMALIZATION_ERROR_CODES];

/** Base normalization error — carries a safe code + retryable classification. */
export class NormalizationError extends Error {
  readonly code: NormalizationErrorCode;
  readonly retryable: boolean;
  constructor(code: NormalizationErrorCode, retryable: boolean, message: string) {
    super(message);
    this.name = 'NormalizationError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** The source artifact ref is absent/unreadable. Terminal. */
export class SourceArtifactNotFoundError extends NormalizationError {
  constructor() {
    super(NORMALIZATION_ERROR_CODES.SOURCE_ARTIFACT_NOT_FOUND, false, 'source artifact not found');
    this.name = 'SourceArtifactNotFoundError';
  }
}

/** Actual source bytes hash != recorded source_sha256 — fail closed. Terminal. */
export class SourceHashMismatchError extends NormalizationError {
  constructor() {
    super(NORMALIZATION_ERROR_CODES.SOURCE_HASH_MISMATCH, false, 'source artifact hash mismatch');
    this.name = 'SourceHashMismatchError';
  }
}

/** No parser registered for the declared source format. Terminal. */
export class SourceFormatUnsupportedError extends NormalizationError {
  constructor() {
    super(NORMALIZATION_ERROR_CODES.SOURCE_FORMAT_UNSUPPORTED, false, 'source format unsupported');
    this.name = 'SourceFormatUnsupportedError';
  }
}

/** The parser could not decode the source. Terminal. Carries NO parser text. */
export class SourceParseFailedError extends NormalizationError {
  constructor() {
    super(NORMALIZATION_ERROR_CODES.SOURCE_PARSE_FAILED, false, 'source parse failed');
    this.name = 'SourceParseFailedError';
  }
}

/** Writing the normalized artifact failed; `retryable` set by the store. */
export class NormalizedArtifactWriteError extends NormalizationError {
  constructor(retryable: boolean) {
    super(NORMALIZATION_ERROR_CODES.NORMALIZED_ARTIFACT_WRITE_FAILED, retryable, 'normalized artifact write failed');
    this.name = 'NormalizedArtifactWriteError';
  }
}

/** The produced normalized transcript failed strict validation. Terminal. */
export class NormalizationSchemaInvalidError extends NormalizationError {
  constructor(detail: string) {
    super(NORMALIZATION_ERROR_CODES.NORMALIZATION_SCHEMA_INVALID, false, `normalized schema invalid: ${detail}`);
    this.name = 'NormalizationSchemaInvalidError';
  }
}
