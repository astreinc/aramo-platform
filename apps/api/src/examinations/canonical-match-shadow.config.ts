import { Injectable } from '@nestjs/common';

// SKILL-TAX-1E — canonical SHADOW-matching activation gate. DARK by default:
// SKILL_CANONICAL_SHADOW_ENABLED must be exactly "true" to enable shadow
// observation. Absent / "false" / anything else → DISABLED, and the examine path
// computes/persists NOTHING extra (zero behavior change vs pre-1E). Server-side
// only — the flag is NEVER request/job-derived. Mirrors the CI_PROCESSING_ENABLED
// dark-inert precedent.
const SKILL_CANONICAL_SHADOW_ENABLED_ENV = 'SKILL_CANONICAL_SHADOW_ENABLED';

@Injectable()
export class CanonicalMatchShadowConfig {
  /** Reads the environment on each call so a flag flip needs only a restart. */
  isEnabled(): boolean {
    return process.env[SKILL_CANONICAL_SHADOW_ENABLED_ENV] === 'true';
  }
}
