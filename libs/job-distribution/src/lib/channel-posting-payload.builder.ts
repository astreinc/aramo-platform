import { createHash } from 'node:crypto';

import type {
  ChannelPostingInput,
  ChannelPostingPayload,
} from './channel-posting.types.js';

// SRC-2 PR-2 (R3) — the allowlist posting-payload builder.
//
// This module is the load-bearing D5-by-construction seam: it composes the
// external posting payload from ONLY the ChannelPostingInput allowlist. It has
// ZERO imports of the requisition repository, projectView, or the field-masking
// maps — a gated value has no path INTO this function. The import-boundary spec
// asserts this module's source references none of them.
//
// The audit finding that projectView emits gated comp/financial fields UNMASKED
// is precisely why this builder exists: a publish egress must never touch
// projectView. It touches only the authored, ungated fields on the input.

export function buildChannelPostingPayload(
  input: ChannelPostingInput,
): ChannelPostingPayload {
  return {
    // The requisition UUID travels as an opaque external reference, never any
    // internal gated field.
    external_requisition_ref: input.requisition_id,
    title: input.title,
    description: input.description,
    location: {
      city: input.city,
      state_code: input.state_code,
      country: input.country,
    },
    job_type: input.job_type,
    work_arrangement: input.work_arrangement,
    openings: input.openings,
    advertised_compensation: {
      min: input.advertised_pay_min,
      max: input.advertised_pay_max,
      period: input.advertised_pay_period,
      currency: input.advertised_pay_currency,
    },
    public_listing: input.public_listing,
    posted_at: input.posted_at,
    updated_at: input.updated_at,
  };
}

// Stable content hash — the R4 sweep's change detector. Canonicalizes the payload
// (recursively key-sorted) so the hash depends only on VALUES, never on key
// insertion order, then sha256-hex. Kept dependency-free (no @aramo import) so the
// lib stays wiring-light.
export function channelPostingContentHash(payload: ChannelPostingPayload): string {
  return createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalStringify(
          (value as Record<string, unknown>)[k],
        )}`,
    );
  return `{${entries.join(',')}}`;
}
