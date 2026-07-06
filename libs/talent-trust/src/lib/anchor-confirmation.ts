// TR-2a-B1 (DDR-1 §2.1 corollary + §2.2 + §3.2) — the confirming/non-confirming
// projection of the anchor tier table.
//
// Tier is a property of (signal kind × attestation level), NOT of signal kind
// alone (DDR-1 §2.1). The SAME email/phone value is Tier-A only when its
// SourceClass is confirming; otherwise it carries corroborator strength and
// ADVISES, never confirms. This function is the anchor substrate's
// confirming/non-confirming projection — the full A/B/C/D taxonomy is spec
// vocabulary the anchor layer does not need. Deliberately NOT named `strength`
// (deriveStrength already exists for evidence — no overload).
//
// LANDED COLD in B1: exported and unit-tested, but NOT yet called by the
// resolver. The resolve decision that consumes it is B2 (DDR-2 §2).

import type { AnchorKind, SourceClass } from './vocab.js';

// The confirming grants (DDR-1 §3.2). EMAIL and PHONE are the Tier-A anchor
// kinds; THIRD_PARTY_VERIFIED is the only confirming class TODAY. SELF and
// THIRD_PARTY_UNVERIFIED corroborate. The higher independence-ladder classes
// (AUTHORITATIVE_ISSUER, CRYPTOGRAPHIC, BIOMETRIC) are semantically Tier-A per
// Spec §6A but have NO anchor producer — per DDR-1 §2.2 fail-closed totality
// they remain non-confirming until a DDR amendment admits each alongside its
// producer. A future PLATFORM_VERIFIED (e.g. magic-link) is reserved likewise.
// Nothing earns confirming power by omission.
const CONFIRMING_ANCHOR_KINDS: ReadonlySet<string> = new Set(['EMAIL', 'PHONE']);
const CONFIRMING_SOURCE_CLASSES: ReadonlySet<string> = new Set(['THIRD_PARTY_VERIFIED']);

// Total and fail-closed (DDR-1 §2.2): any (kind, class) pair not explicitly
// granted confirming power — including unknown/future kinds or classes passed
// as out-of-union strings — is non-confirming.
export function isConfirmingAnchor(
  anchorKind: AnchorKind,
  sourceClass: SourceClass,
): boolean {
  return (
    CONFIRMING_ANCHOR_KINDS.has(anchorKind) &&
    CONFIRMING_SOURCE_CLASSES.has(sourceClass)
  );
}
