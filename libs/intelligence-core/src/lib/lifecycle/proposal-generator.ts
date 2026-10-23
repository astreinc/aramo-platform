import { VERIFICATION_VALIDITY_DAYS, type ProposalKind, type ProposalTriggerKind } from '@aramo/intelligence-contracts';

import { identifierDigest, type ProjectionAssertion, type ProjectionIdentifier, type ProjectionResult } from '../projection/projection.js';
import type { JsonObject } from '../repositories/types.js';

// ATI-SEP-1 T10 M-2 — the caseworker's PURE policy engine, ported from the
// legacy proposal generator (rules unchanged, re-expressed on the Golden model).
// Deterministic rules over ONE tenant's view of a subject; it mints the DESIRED
// set of proposals and never invokes an action (propose-never-dispose). Silent
// unless sure: a subject with fresh verification, no contradiction and a
// verified or multi-source contact yields [].
//
//   RESOLVE_CONTRADICTION ← each CONTRADICTED assertion of the view (basis = the assertion)
//   RENEW_VERIFICATION    ← trust.verification_stale ∧ a contact whose latest TI
//                           verification is older than 365 days (basis = the contact digest)
//   VERIFY_CONTACT        ← trust.single_source_only ∧ a contact never verified by TI
//                           (basis = the contact digest)
// A basis never carries a contact value — only its type and sha256 digest.

export interface DesiredProposal {
  kind: ProposalKind;
  trigger_kind: ProposalTriggerKind;
  basis_ref: string;
  assertion_id: string | null;
  identifier_type: 'EMAIL' | 'PHONE' | null;
  identifier_digest: string | null;
  basis_snapshot: JsonObject;
}

const MS_PER_DAY = 86_400_000;

export function generateProposals(
  view: { assertions: ProjectionAssertion[]; identifiers: ProjectionIdentifier[]; projection: ProjectionResult },
  now: Date,
): DesiredProposal[] {
  const out: DesiredProposal[] = [];
  const { projection } = view;

  for (const a of view.assertions) {
    if (projection.effective_status.get(a.id) !== 'CONTRADICTED') continue;
    out.push({
      kind: 'RESOLVE_CONTRADICTION',
      trigger_kind: 'OPEN_CONTRADICTION',
      basis_ref: `assertion:${a.id}`,
      assertion_id: a.id,
      identifier_type: null,
      identifier_digest: null,
      basis_snapshot: { assertion_type: a.assertion_type },
    });
  }

  // One slot per distinct contact (type + value); the latest TI verification of each.
  const slots = new Map<string, { type: 'EMAIL' | 'PHONE'; digest: string }>();
  for (const i of view.identifiers) {
    if (i.status !== 'ACTIVE' || (i.identifier_type !== 'EMAIL' && i.identifier_type !== 'PHONE')) continue;
    const digest = identifierDigest(i.identifier_type, i.normalized_value);
    slots.set(digest, { type: i.identifier_type, digest });
  }
  const latestVerification = new Map<string, number>();
  for (const a of view.assertions) {
    if (a.assertion_type !== 'VERIFICATION_OUTCOME' || a.source_kind !== 'VERIFICATION') continue;
    if (!projection.effective_status.has(a.id)) continue;
    const digest = a.payload['identifier_digest'];
    if (typeof digest !== 'string') continue;
    latestVerification.set(digest, Math.max(latestVerification.get(digest) ?? 0, a.observed_at.getTime()));
  }

  const ordered = [...slots.values()].sort((x, y) => (x.digest < y.digest ? -1 : 1));
  if (projection.trust.verification_stale) {
    for (const s of ordered) {
      const at = latestVerification.get(s.digest);
      if (at === undefined || now.getTime() - at <= VERIFICATION_VALIDITY_DAYS * MS_PER_DAY) continue;
      out.push(contactProposal('RENEW_VERIFICATION', 'VERIFICATION_STALE', s));
    }
  }
  if (projection.trust.single_source_only) {
    for (const s of ordered) {
      if (latestVerification.has(s.digest)) continue;
      out.push(contactProposal('VERIFY_CONTACT', 'SINGLE_SOURCE_ONLY', s));
    }
  }
  return out;
}

function contactProposal(kind: ProposalKind, trigger: ProposalTriggerKind, s: { type: 'EMAIL' | 'PHONE'; digest: string }): DesiredProposal {
  return {
    kind,
    trigger_kind: trigger,
    basis_ref: `identifier:${s.digest}`,
    assertion_id: null,
    identifier_type: s.type,
    identifier_digest: s.digest,
    basis_snapshot: { identifier_type: s.type },
  };
}
