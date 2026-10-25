import { v7 as uuidv7 } from 'uuid';

import type { PrismaService } from '../prisma/prisma.service.js';

import { POLICY_TARGET_CHECKSUM_KEY } from './commercial-change-request.js';
import { commercialPolicyChecksum, parseCommercialPolicyContent } from './commercial-policy.js';

// CCP-B5 (TD-A9-16; Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B5) — the policy
// write of an APPROVED POLICY_ACTIVATE, run INSIDE the caller's apply transaction after the
// NC-5 signature re-check (CommercialChangeRequestService.applyPolicyActivation).
//
// The NC-5 SNAPSHOT re-check (TD-A3-0 ratified; pre-execution C-2). The request was decided
// against a snapshot: the ACTIVE version it was created under (`policy_version_id` +
// `policy_checksum`) and the target's content (`payload.target_content_checksum`). The apply
// refuses — fail closed, writing nothing — when that snapshot no longer holds:
//   POLICY_ACTIVE_CHANGED   another version became ACTIVE after the request was created
//   TARGET_CHANGED          the target's content differs from what the approvers saw
//   TARGET_NOT_ACTIVATABLE  the target is no longer DRAFT or RETIRED
//   TARGET_NOT_FOUND / TARGET_SNAPSHOT_MISSING / TARGET_MALFORMED
// It never consults a newer policy version, and it never touches the request row or an
// approval row (the guard admits no transition out of APPROVED for POLICY_ACTIVATE;
// pre-execution C-1).
//
// The write: the ACTIVE version → RETIRED, then the target → ACTIVE (the A2 policy trigger
// permits DRAFT → ACTIVE, RETIRED → ACTIVE and ACTIVE → RETIRED; retiring first keeps the
// one-ACTIVE partial unique index satisfied), plus the policy-governance audit rows.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export type PolicyActivationRefusalReason =
  | 'TARGET_SNAPSHOT_MISSING'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_ACTIVATABLE'
  | 'TARGET_CHANGED'
  | 'TARGET_MALFORMED'
  | 'POLICY_ACTIVE_CHANGED';

export class PolicyActivationRefusedError extends Error {
  constructor(
    readonly reason: PolicyActivationRefusalReason,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`policy activation not applied (${reason})`);
    this.name = 'PolicyActivationRefusedError';
  }
}

/** One lock for every policy write (the CCP-A2 repository's key). */
export const POLICY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('subscription.commercial_policy'))`;

export interface PolicyActivationSnapshot {
  /** The ACTIVE version the request was created under, and its checksum. */
  policy_version_id: string;
  policy_checksum: string;
  payload: unknown;
}

export interface PolicyActivationResult {
  from_version_id: string;
  from_version_number: number;
  to_version_id: string;
  to_version_number: number;
  to_content_checksum: string;
  /** DRAFT (an activation) or RETIRED (a rollback). */
  to_previous_status: 'DRAFT' | 'RETIRED';
}

interface VersionRow {
  id: string;
  version_number: number;
  status: string;
  content: unknown;
  content_checksum: string;
}

/**
 * The NC-5 snapshot re-check plus the policy write. Takes the policy advisory lock and
 * locks both rows (FOR UPDATE). Throws PolicyActivationRefusedError before any write when
 * the snapshot no longer holds.
 */
export async function activatePolicyVersionInTx(
  tx: Tx,
  snap: PolicyActivationSnapshot,
  input: { activated_by: string; at: Date; change_request_id: string },
): Promise<PolicyActivationResult> {
  const p = (snap.payload ?? {}) as Record<string, unknown>;
  const target_id = p['policy_version_id'];
  const snapshot_checksum = p[POLICY_TARGET_CHECKSUM_KEY];
  if (typeof target_id !== 'string') throw new PolicyActivationRefusedError('TARGET_NOT_FOUND', { reason: 'payload_policy_version_id' });
  if (typeof snapshot_checksum !== 'string') throw new PolicyActivationRefusedError('TARGET_SNAPSHOT_MISSING', { policy_version_id: target_id });

  await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
  const active = (
    await tx.$queryRawUnsafe<VersionRow[]>(
      `SELECT id::text AS id, version_number, status, content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE' FOR UPDATE`,
    )
  )[0];
  if (active === undefined || active.id !== snap.policy_version_id || active.content_checksum !== snap.policy_checksum) {
    throw new PolicyActivationRefusedError('POLICY_ACTIVE_CHANGED', {
      request_policy_version_id: snap.policy_version_id,
      active_policy_version_id: active?.id ?? null,
    });
  }
  const target = (
    await tx.$queryRawUnsafe<VersionRow[]>(
      `SELECT id::text AS id, version_number, status, content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1::uuid FOR UPDATE`,
      target_id,
    )
  )[0];
  if (target === undefined) throw new PolicyActivationRefusedError('TARGET_NOT_FOUND', { policy_version_id: target_id });
  if (target.status !== 'DRAFT' && target.status !== 'RETIRED') {
    throw new PolicyActivationRefusedError('TARGET_NOT_ACTIVATABLE', { policy_version_id: target_id, status: target.status });
  }
  if (target.content_checksum !== snapshot_checksum) {
    throw new PolicyActivationRefusedError('TARGET_CHANGED', { policy_version_id: target_id, snapshot_checksum, current_checksum: target.content_checksum });
  }
  // The content that goes ACTIVE must pass the strict parser and match its stored checksum
  // (the ACTIVE reader would otherwise fail closed on the next commercial decision).
  try {
    parseCommercialPolicyContent(target.content);
  } catch (e) {
    throw new PolicyActivationRefusedError('TARGET_MALFORMED', { policy_version_id: target_id, errors: (e as { errors?: unknown }).errors ?? [] });
  }
  if (commercialPolicyChecksum(target.content) !== target.content_checksum) {
    throw new PolicyActivationRefusedError('TARGET_MALFORMED', { policy_version_id: target_id, reason: 'checksum_mismatch' });
  }

  await tx.$executeRawUnsafe(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = $2 WHERE id = $1::uuid`, active.id, input.at);
  await tx.$executeRawUnsafe(
    `UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = $2, activated_by = $3::uuid, retired_at = NULL WHERE id = $1::uuid`,
    target.id,
    input.at,
    input.activated_by,
  );
  const governance = (event_type: string, subject_id: string, payload: Record<string, unknown>) =>
    tx.commercialPolicyAuditEvent.create({
      data: { id: uuidv7(), actor_id: input.activated_by, actor_type: 'user', event_type, subject_id, event_payload: payload as object, created_at: input.at },
    });
  await governance('COMMERCIAL_POLICY_VERSION_RETIRED', active.id, { version_number: active.version_number, replaced_by: target.id, change_request_id: input.change_request_id });
  await governance('COMMERCIAL_POLICY_VERSION_ACTIVATED', target.id, {
    version_number: target.version_number,
    content_checksum: target.content_checksum,
    previous_status: target.status,
    replaces: active.id,
    change_request_id: input.change_request_id,
  });
  return {
    from_version_id: active.id,
    from_version_number: active.version_number,
    to_version_id: target.id,
    to_version_number: target.version_number,
    to_content_checksum: target.content_checksum,
    to_previous_status: target.status as 'DRAFT' | 'RETIRED',
  };
}
