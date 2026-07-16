import { createHmac, timingSafeEqual } from 'node:crypto';

import { loadIdentityPepper } from '@aramo/common';

import type { PortalDisputeItemType } from './vocab.js';

// Portal P3a (directive ruling 2 + Q4) — the opaque, wire-only item-id surrogate
// for the talent verification view. A view "item" is a deduped anchor/claim
// that may span N subjects across the OPEN-4 chain; disputing it fans out to N
// tenant-scoped work items. The id shown on the wire must:
//   - be non-guessable + per-talent scoped (a different cluster mints
//     different ids for the same underlying rows — no cross-talent oracle);
//   - carry NO raw PK and NO PII (never the SubjectAnchor 5-col tuple / email);
//   - be resolvable server-side back to the underlying rows WITHOUT persisting a
//     reversible mapping.
//
// Construction: HMAC-SHA256(pepper, `portal-verification-item-v1:` + cluster_id +
// item_type + sorted(underlying_ref_ids)), lowercase hex. Deterministic, so the
// service RE-DERIVES the id for each of the caller's items and matches the
// submitted id (one-way; nothing to reverse). The pepper is the platform secret
// held separate from the DB (reused from the identity fingerprint; the domain
// prefix keeps this id-space disjoint from the email fingerprint). The digest is
// ALSO stored on the dispute row as item_id_digest — only for the one-open-per-
// item idempotency read, never re-emitted on the wire as anything but this id.

const ITEM_ID_DOMAIN = 'portal-verification-item-v1:';

/**
 * Mint the opaque item id for a view item. `underlyingRefIds` is the set of
 * SubjectAnchor.id / VerificationRequest.id rows the deduped item spans; the
 * order is normalized (sorted) so the id is stable regardless of enumeration
 * order. Returns lowercase hex.
 */
export function mintPortalVerificationItemId(input: {
  clusterId: string;
  itemType: PortalDisputeItemType;
  underlyingRefIds: readonly string[];
  pepper?: string;
}): string {
  const key = input.pepper ?? loadIdentityPepper();
  const sorted = [...input.underlyingRefIds].sort();
  const preimage =
    ITEM_ID_DOMAIN + input.clusterId + '|' + input.itemType + '|' + sorted.join(',');
  return createHmac('sha256', key).update(preimage, 'utf8').digest('hex');
}

/**
 * Constant-time compare of a talent-supplied item id against a re-derived one
 * (avoids a timing oracle on the digest). Both are lowercase hex of equal length
 * on the happy path; a length mismatch is a plain false (no throw — a malformed
 * id is just "not found", preserving the uniform 404).
 */
export function portalVerificationItemIdMatches(supplied: string, derived: string): boolean {
  if (supplied.length !== derived.length) return false;
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(derived));
  } catch {
    return false;
  }
}
