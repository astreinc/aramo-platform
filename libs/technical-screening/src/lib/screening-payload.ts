import { hashCanonicalizedBody } from '@aramo/common';

import type { ScreeningBasis } from './screening-vocab.js';

// TIP-E2E INC-3 — the canonical SCREENING_FINDING payload pinned on a publication
// intent at confirmation (directive §6 step 2; shape per
// Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED §2.1). No actor identifier, no numeric
// rating. Talent Trust re-validates and re-canonicalizes the same shape on write
// (it derives skill_id); the hash here is over exactly what is pinned.

export interface ScreeningPayloadFinding {
  id: string;
  skill_raw: string;
  basis: string;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
}

export function buildScreeningFindingPayload(args: {
  session_id: string;
  finding: ScreeningPayloadFinding;
  confirmed_at: Date;
  confirmed_version: number;
}): Record<string, unknown> {
  const { finding } = args;
  const payload: Record<string, unknown> = {
    skill_raw: finding.skill_raw,
    basis: finding.basis as ScreeningBasis,
    observation_raw: finding.observation_raw,
    independently_verified: false,
    confirmation: {
      confirmed_at: args.confirmed_at.toISOString(),
      session_version: args.confirmed_version,
    },
    screening_ref: {
      screening_session_id: args.session_id,
      screening_finding_id: finding.id,
    },
  };
  if (finding.basis === 'DEMONSTRATED' && finding.demonstration_raw !== null) {
    payload['demonstration_raw'] = finding.demonstration_raw;
  }
  if (finding.limitations_raw !== null && finding.limitations_raw.length > 0) {
    payload['limitations_raw'] = finding.limitations_raw;
  }
  return payload;
}

export function screeningPayloadHash(payload: Record<string, unknown>): string {
  return hashCanonicalizedBody(payload);
}
