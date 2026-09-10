import { Injectable } from '@nestjs/common';

// CI-B6P §6/§7/§34 — the production CI-processing configuration + activation
// gate. Two concerns, both server-side only (never request/job-derived):
//
//   1. ACTIVATION (dark by default). CI_PROCESSING_ENABLED must be exactly
//      "true" to enable. Absent / "false" / anything else → DISABLED. When
//      disabled, no run is scheduled and no model is ever invoked. Safe to
//      merge and deploy without making real model calls.
//
//   2. MODEL ALLOWLIST (fail-closed). CI_ANTHROPIC_MODEL must be one of the
//      allowlisted, structured-output-capable Anthropic model ids. Missing or
//      non-allowlisted → fail-closed (no fallback model, ever). The id can
//      NEVER come from an HTTP request or a queue job.

/**
 * Allowlisted production model ids. Each supports native structured output
 * (output_config.format) per Anthropic's GA structured-outputs support.
 */
export const CI_ALLOWLISTED_MODELS: readonly string[] = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-opus-5',
];

/** Max output tokens for a structured analysis generation. */
export const CI_MODEL_MAX_OUTPUT_TOKENS = 8192;

const CI_PROCESSING_ENABLED_ENV = 'CI_PROCESSING_ENABLED';
const CI_ANTHROPIC_MODEL_ENV = 'CI_ANTHROPIC_MODEL';

/** Thrown when activation is on but the model config is missing/non-allowlisted. */
export class CiProcessingConfigError extends Error {
  constructor(readonly reason: 'model_missing' | 'model_not_allowlisted') {
    super(`CI processing config invalid: ${reason}`);
    this.name = 'CiProcessingConfigError';
  }
}

@Injectable()
export class CiProcessingConfig {
  /** Reads the environment on each call so a flag flip needs only a restart. */
  isEnabled(): boolean {
    return process.env[CI_PROCESSING_ENABLED_ENV] === 'true';
  }

  /**
   * The configured, allowlisted model id. Fail-closed: throws
   * {@link CiProcessingConfigError} when unset or not allowlisted. There is no
   * fallback model. Callers invoke this only after the activation gate.
   */
  resolveModel(): string {
    const raw = process.env[CI_ANTHROPIC_MODEL_ENV];
    if (raw === undefined || raw.length === 0) {
      throw new CiProcessingConfigError('model_missing');
    }
    if (!CI_ALLOWLISTED_MODELS.includes(raw)) {
      throw new CiProcessingConfigError('model_not_allowlisted');
    }
    return raw;
  }

  /** True when enabled AND the model config is valid (no throw). */
  isReady(): boolean {
    if (!this.isEnabled()) return false;
    try {
      this.resolveModel();
      return true;
    } catch {
      return false;
    }
  }
}
