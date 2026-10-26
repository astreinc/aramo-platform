import type { PrismaService } from '../prisma/prisma.service.js';

import { REFUND_POLICY_NOT_APPROVED, refundExecutionEnabled } from './commercial-billing-adjustment.js';
import { type CommercialPolicyContent, CommercialPolicyUnavailableError, parseActiveCommercialPolicy } from './commercial-policy.js';

// CCP-DG — the refund dual gate (Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED,
// RX-5…RX-9; the C4-P successor).
//
// NEW refund execution (the first provider dispatch of a REFUND command, or an authorized re-arm of a
// FAILED one) requires BOTH gates, checked at the initial apply AND again immediately before the first
// provider dispatch or a permitted re-arm:
//
//   Gate 1 (RX-5, operational): CCP_REFUND_EXECUTION_ENABLED=1 on the executing service.
//           Refusal REFUND_EXECUTION_NOT_RELEASED.
//   Gate 2 (RX-6, commercial): the CURRENT ACTIVE policy AND the request's SNAPSHOTTED policy both
//           declare refund_execution_enabled = true with a valid refund_policy_ref and
//           refund_policy_sha256, and the two carry the SAME refund-policy identity (equal ref, equal
//           sha). The full policy checksums need not match (RX-6 clarification). The request's
//           payload refund_policy_ref must equal that ref (RX-8, again at apply).
//           Refusal REFUND_POLICY_NOT_APPROVED.
//
// RX-7 independence: each gate is evaluated on its own inputs; neither can stand in for the other.
// When both fail, the operational refusal is reported (gate 1 is evaluated first) and the detail
// names both outcomes.
//
// RX-10: webhook processing, read-only reconciliation, recording an already-confirmed refund as
// applied and the governed terminal resolution NEVER call this module.

/** RX-D1 — the operational gate's refusal (the commercial gate's is REFUND_POLICY_NOT_APPROVED). */
export const REFUND_EXECUTION_NOT_RELEASED = 'REFUND_EXECUTION_NOT_RELEASED';

/** RX-7 — the one audit row of a refusal taken by the dispatcher (the apply path records APPLY_REFUSED). */
export const REFUND_DISPATCH_REFUSED_EVENT = 'COMMERCIAL_REFUND_DISPATCH_REFUSED';

export type RefundExecutionRefusal = typeof REFUND_EXECUTION_NOT_RELEASED | typeof REFUND_POLICY_NOT_APPROVED;

/** One approved refund-policy identity (RX-6): the reference and the document hash. */
export interface RefundPolicyIdentity {
  refund_policy_ref: string;
  refund_policy_sha256: string;
}

/** Why gate 2 did not pass (the refusal detail; no policy content, no amount). */
export type RefundPolicyGateBasis =
  | 'ACTIVE_POLICY_UNAVAILABLE'
  | 'ACTIVE_POLICY_NOT_ENABLED'
  | 'SNAPSHOT_POLICY_UNAVAILABLE'
  | 'SNAPSHOT_POLICY_NOT_ENABLED'
  | 'REFUND_POLICY_IDENTITY_CHANGED'
  | 'PAYLOAD_REF_MISMATCH';

export type RefundExecutionDecision =
  | { ok: true; identity: RefundPolicyIdentity }
  | { ok: false; refusal: RefundExecutionRefusal; gate_1_released: boolean; gate_2: 'APPROVED' | RefundPolicyGateBasis };

/**
 * Pure: the refund-policy identity a parsed policy ENABLES, or null (keys absent, or
 * refund_execution_enabled = false). The parser has already enforced all-or-none and the formats.
 */
export function enabledRefundPolicyIdentity(content: CommercialPolicyContent | null): RefundPolicyIdentity | null {
  if (content === null || content.refund_execution_enabled !== true) return null;
  if (typeof content.refund_policy_ref !== 'string' || typeof content.refund_policy_sha256 !== 'string') return null;
  return { refund_policy_ref: content.refund_policy_ref, refund_policy_sha256: content.refund_policy_sha256 };
}

/** Pure: gate 2 alone (RX-6, RX-8 at apply, RX-9). */
export function refundPolicyGate(input: {
  /** The current ACTIVE policy, parsed fail-closed (null = missing / malformed / tampered). */
  active: CommercialPolicyContent | null;
  /** The request's own snapshotted policy version, parsed and checksum-verified (null = unavailable). */
  snapshot: CommercialPolicyContent | null;
  /** The REFUND payload's `refund_policy_ref`. */
  payload_ref: unknown;
}): 'APPROVED' | RefundPolicyGateBasis {
  if (input.active === null) return 'ACTIVE_POLICY_UNAVAILABLE';
  const active = enabledRefundPolicyIdentity(input.active);
  if (active === null) return 'ACTIVE_POLICY_NOT_ENABLED';
  if (input.snapshot === null) return 'SNAPSHOT_POLICY_UNAVAILABLE';
  const snap = enabledRefundPolicyIdentity(input.snapshot);
  if (snap === null) return 'SNAPSHOT_POLICY_NOT_ENABLED';
  if (snap.refund_policy_ref !== active.refund_policy_ref || snap.refund_policy_sha256 !== active.refund_policy_sha256) return 'REFUND_POLICY_IDENTITY_CHANGED';
  if (input.payload_ref !== snap.refund_policy_ref) return 'PAYLOAD_REF_MISMATCH';
  return 'APPROVED';
}

/** Pure: the dual gate (RX-5…RX-7). Exactly one combination proceeds: switch on AND policy approved. */
export function decideRefundExecution(input: { switch_on: boolean; active: CommercialPolicyContent | null; snapshot: CommercialPolicyContent | null; payload_ref: unknown }): RefundExecutionDecision {
  const gate_2 = refundPolicyGate(input);
  if (!input.switch_on) return { ok: false, refusal: REFUND_EXECUTION_NOT_RELEASED, gate_1_released: false, gate_2 };
  if (gate_2 !== 'APPROVED') return { ok: false, refusal: REFUND_POLICY_NOT_APPROVED, gate_1_released: true, gate_2 };
  const identity = enabledRefundPolicyIdentity(input.active) as RefundPolicyIdentity;
  return { ok: true, identity };
}

type PolicyReader = Pick<PrismaService, 'commercialPolicyVersion'>;

/** The fields of a REFUND change request the gate reads. */
export interface RefundGateRequest {
  policy_version_id: string;
  policy_checksum: string;
  payload: unknown;
}

/**
 * The dual gate against the database (the caller's transaction, or the root client): the current
 * ACTIVE version and the request's snapshotted version, each through the fail-closed parser with its
 * checksum re-verified (and the snapshot's checksum equal to the one the request pinned, NC-5).
 * Reads only; never a provider call.
 */
export async function evaluateRefundExecution(
  client: PolicyReader,
  req: RefundGateRequest,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RefundExecutionDecision> {
  const active = await readParsed(async () => parseActiveCommercialPolicy(await client.commercialPolicyVersion.findFirst({ where: { status: 'ACTIVE' } })));
  const snapshot = await readParsed(async () => {
    const row = await client.commercialPolicyVersion.findUnique({ where: { id: req.policy_version_id } });
    if (row === null || row.status === 'DRAFT') throw new CommercialPolicyUnavailableError('MISSING');
    const p = parseActiveCommercialPolicy({ ...row, status: 'ACTIVE' });
    if (p.checksum !== req.policy_checksum) throw new CommercialPolicyUnavailableError('CHECKSUM_MISMATCH');
    return p;
  });
  const payload_ref = ((req.payload ?? {}) as Record<string, unknown>)['refund_policy_ref'];
  return decideRefundExecution({ switch_on: refundExecutionEnabled(env), active, snapshot, payload_ref });
}

async function readParsed(read: () => Promise<{ content: CommercialPolicyContent }>): Promise<CommercialPolicyContent | null> {
  try {
    return (await read()).content;
  } catch (e) {
    if (e instanceof CommercialPolicyUnavailableError) return null;
    throw e;
  }
}

/** The refusal detail recorded in the audit row / command (both gate outcomes; no content, no amount). */
export function refundGateDetail(d: Extract<RefundExecutionDecision, { ok: false }>): Record<string, unknown> {
  return { gate_1_released: d.gate_1_released, gate_2: d.gate_2 };
}

/**
 * RX-8 at CREATE — the payload's `refund_policy_ref` must equal the snapshotted (= the ACTIVE at
 * creation) policy's `refund_policy_ref` when that policy declares the refund keys. Under a policy
 * without the keys the payload ref stays a proposal only (execution stays refused by gate 2).
 * Returns null when bound (or not applicable), else the declared reference.
 */
export function refundPolicyRefBindingError(snapshot: CommercialPolicyContent, payload_ref: unknown): { declared_ref: string } | null {
  if (typeof snapshot.refund_policy_ref !== 'string') return null;
  return payload_ref === snapshot.refund_policy_ref ? null : { declared_ref: snapshot.refund_policy_ref };
}
