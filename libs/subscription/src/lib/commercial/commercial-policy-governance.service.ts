import { Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { COMMERCIAL_OPEN_STATES, POLICY_TARGET_CHECKSUM_KEY } from './commercial-change-request.js';
import { CommercialChangeRequestError, CommercialChangeRequestService, applyActionable, type CommercialActor, type CommercialCallContext } from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';
import { POLICY_LOCK_SQL } from './commercial-policy-activation.js';
import {
  COMMERCIAL_POLICY_KEYS,
  CommercialPolicyUnavailableError,
  commercialPolicyChecksum,
  parseCommercialPolicyContent,
  type CommercialPolicyContent,
} from './commercial-policy.js';
import { CommercialPolicyRepository, type CommercialPolicyVersionRow } from './commercial-policy.repository.js';

// CCP-B5 (B5-P; handoff §5.6; pre-execution C-4) — the commercial policy screen's backend:
// the version list, and DRAFT authoring (create a draft from a version; edit a draft).
// Activation and rollback are NOT here: they are POLICY_ACTIVATE change requests (A3
// engine; requested by finance_admin, TD-A3-5; chain finance → owner, Q1) applied by their
// requester through the governed apply command (CommercialPolicyApplyService; CCP-B5-R, TD-B5-1).
//
// Authority. The A1 catalog holds no governance scope (TD-A3-5), so the routes are gated on
// platform:approval:read and the AUTHOR is the live platform_owner or finance_admin role,
// read inside the write transaction (handoff §5.6 "editable inline only on a Draft, by
// platform_owner or finance_admin"). Every write runs under the one policy advisory lock
// (shared with the POLICY_ACTIVATE create and apply), so a draft cannot change between a
// request's snapshot and its apply without the apply refusing (TARGET_CHANGED).
//
// CCP-ACC-1: `withdraw_actionable` — the caller requested this APPLY_FAILED activation (a UI hint;
// the withdrawal re-checks authority and reconciles in its own transaction).
const withdrawActionable = (actor: CommercialActor, o: { state: string; requested_by: string }): boolean =>
  actor.actor_kind === 'user' && actor.user_id === o.requested_by && o.state === 'APPLY_FAILED';

// Rules: exactly one DRAFT at a time; a DRAFT targeted by an OPEN POLICY_ACTIVATE (CCP-B5-R:
// COMMERCIAL_OPEN_STATES — DRAFT, PENDING_APPROVAL, APPROVED, APPLYING, APPLY_FAILED) is locked; only DRAFT content changes (the A2 trigger is the DB authority).
// Edits are bounded by the handoff §5.6 allowed ranges on top of the strict A2 parser.
// Audit: CommercialPolicyAuditEvent COMMERCIAL_POLICY_VERSION_CREATED (its closed CHECK) and
// CommercialAuditEvent COMMERCIAL_POLICY_VERSION_DRAFTED / COMMERCIAL_POLICY_DRAFT_UPDATED.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export const POLICY_AUTHOR_ROLES = ['platform_owner', 'finance_admin'] as const;

/**
 * Handoff §5.6 "Allowed range" per setting, in the policy document's units (basis points,
 * USD minor units, days, hours). The strict A2 parser still applies on top (it refuses 0 for
 * the two thresholds).
 */
export const POLICY_EDIT_RANGES: Readonly<Partial<Record<keyof CommercialPolicyContent, readonly [number, number]>>> = {
  discount_escalation_threshold_bps: [0, 10_000],
  credit_escalation_threshold_minor: [0, 10_000_000],
  support_extension_max_days: [1, 60],
  support_extension_frequency_window_days: [30, 365],
  support_extension_cumulative_max_days: [1, 120],
  approval_expiry_hours: [12, 168],
  past_due_grace_days: [0, 30],
};

/** The keys a draft edit may change (format_version and currency are fixed in format 1). */
export const POLICY_EDITABLE_KEYS = [...Object.keys(POLICY_EDIT_RANGES), 'support_extension_cumulative_window_days'] as const;

export interface PolicyVersionView {
  row: CommercialPolicyVersionRow;
  /** The parsed content, or null when the stored document fails the strict parser. */
  content: CommercialPolicyContent | null;
  /**
   * The open POLICY_ACTIVATE request targeting this version (COMMERCIAL_OPEN_STATES), with the
   * caller's apply hint (CCP-B5-R: requester-only, APPROVED / APPLY_FAILED).
   */
  open_request: { id: string; state: string; apply_actionable: boolean; withdraw_actionable: boolean } | null;
  /** CCP-B5-R — the most recent POLICY_ACTIVATE request targeting this version, in any state. */
  latest_request: { id: string; state: string; applied_at: Date | null } | null;
}

export interface PolicyListView {
  versions: PolicyVersionView[];
  active_version_id: string | null;
  /** The one open policy request (COMMERCIAL_OPEN_STATES), whatever it targets. */
  open_request: { id: string; state: string; policy_version_id: string } | null;
  caller: { can_author: boolean; can_request_activation: boolean };
}

/** Pure: range errors of a proposed content against POLICY_EDIT_RANGES. */
export function policyRangeErrors(content: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [k, [min, max]] of Object.entries(POLICY_EDIT_RANGES) as Array<[string, readonly [number, number]]>) {
    const v = content[k];
    if (typeof v === 'number' && (v < min || v > max)) errors.push(`${k} must be between ${min} and ${max}`);
  }
  return errors;
}

@Injectable()
export class CommercialPolicyGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: CommercialPolicyRepository,
    private readonly audit: CommercialAuditRepository,
    private readonly operators: CommercialOperatorRepository,
    @Optional() private readonly changeRequests?: CommercialChangeRequestService,
  ) {}

  async list(actor: CommercialActor, ctx: CommercialCallContext): Promise<PolicyListView> {
    // Charter Amendment A1 (AD-7; CCP-B5-R) — the read evaluates the apply deadline lazily.
    await this.changeRequests?.lazyExpirePolicyActivations(ctx);
    const rows = await this.policies.listVersions();
    const all = await this.prisma.commercialChangeRequest.findMany({
      where: { action_type: 'POLICY_ACTIVATE' },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, state: true, payload: true, requested_by: true, action_type: true, applied_at: true },
    });
    const open = all.filter((r) => (COMMERCIAL_OPEN_STATES as readonly string[]).includes(r.state));
    const target = (p: unknown): string => String((p as Record<string, unknown> | null)?.['policy_version_id'] ?? '');
    const live = await this.operators.readOperator(this.prisma, ctx.platform_tenant_id, actor.user_id);
    const versions = rows.map((row) => {
      let content: CommercialPolicyContent | null = null;
      try {
        content = parseCommercialPolicyContent(row.content);
      } catch {
        content = null;
      }
      const o = open.find((r) => target(r.payload) === row.id);
      const l = all.find((r) => target(r.payload) === row.id);
      return {
        row,
        content,
        open_request: o === undefined ? null : { id: o.id, state: o.state, apply_actionable: applyActionable(actor, o), withdraw_actionable: withdrawActionable(actor, o) },
        latest_request: l === undefined ? null : { id: l.id, state: l.state, applied_at: l.applied_at },
      };
    });
    const first = open[0];
    return {
      versions,
      active_version_id: rows.find((r) => r.status === 'ACTIVE')?.id ?? null,
      open_request: first === undefined ? null : { id: first.id, state: first.state, policy_version_id: target(first.payload) },
      caller: {
        can_author: live.role_keys.some((r) => (POLICY_AUTHOR_ROLES as readonly string[]).includes(r)),
        can_request_activation: actor.actor_kind === 'user' && live.attested && live.role_keys.includes('finance_admin'),
      },
    };
  }

  /** A new DRAFT whose content is a copy of `source_version_id` (any non-DRAFT version). */
  async createDraft(actor: CommercialActor, input: { source_version_id: string; note?: string | null }, ctx: CommercialCallContext): Promise<CommercialPolicyVersionRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const roles = await this.requireAuthor(tx, actor, ctx);
      const draft = await tx.commercialPolicyVersion.findFirst({ where: { status: 'DRAFT' }, select: { id: true, version_number: true } });
      if (draft !== null) {
        throw new CommercialChangeRequestError('STATE_INVALID', 'a draft policy version already exists', { reason: 'policy_draft_exists', draft_version_id: draft.id, draft_version_number: draft.version_number });
      }
      const source = await tx.commercialPolicyVersion.findUnique({ where: { id: input.source_version_id } });
      if (source === null) throw new CommercialChangeRequestError('NOT_FOUND', 'policy version not found', { id: input.source_version_id });
      if (source.status === 'DRAFT') throw new CommercialChangeRequestError('INVALID_INPUT', 'a draft cannot be copied', { reason: 'policy_source_is_draft' });
      const content = this.strict(source.content);
      const checksum = commercialPolicyChecksum(content);
      const latest = await tx.commercialPolicyVersion.aggregate({ _max: { version_number: true } });
      const version_number = (latest._max.version_number ?? 0) + 1;
      const note = (input.note ?? '').trim() || `Draft from v${source.version_number}`;
      const id = uuidv7();
      const row = await tx.commercialPolicyVersion.create({
        data: { id, version_number, status: 'DRAFT', content: content as object, content_checksum: checksum, note, created_by: actor.user_id },
      });
      await tx.commercialPolicyAuditEvent.create({
        data: {
          id: uuidv7(),
          actor_id: actor.user_id,
          actor_type: 'user',
          event_type: 'COMMERCIAL_POLICY_VERSION_CREATED',
          subject_id: id,
          event_payload: { version_number, content_checksum: checksum, content: content as object, note, source_version_id: source.id },
        },
      });
      await this.appendAudit(tx, actor, roles, 'COMMERCIAL_POLICY_VERSION_DRAFTED', id, { version_number, source_version_id: source.id, source_version_number: source.version_number, content_checksum: checksum }, ctx);
      return row as CommercialPolicyVersionRow;
    });
  }

  /** Edits a DRAFT (content keys in POLICY_EDITABLE_KEYS and/or the note). */
  async updateDraft(actor: CommercialActor, id: string, input: { content?: Record<string, unknown>; note?: string | null }, ctx: CommercialCallContext): Promise<CommercialPolicyVersionRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(POLICY_LOCK_SQL);
      const roles = await this.requireAuthor(tx, actor, ctx);
      const row = await tx.commercialPolicyVersion.findUnique({ where: { id } });
      if (row === null) throw new CommercialChangeRequestError('NOT_FOUND', 'policy version not found', { id });
      if (row.status !== 'DRAFT') {
        throw new CommercialChangeRequestError('STATE_INVALID', `a ${row.status} policy version is immutable; create a new draft`, { reason: 'policy_version_not_draft', status: row.status });
      }
      // CCP-B5-R: an approved activation whose apply authority lapsed releases its draft (AD-5, AD-7).
      if (this.changeRequests !== undefined) await this.changeRequests.expireOpenPolicyActivations(tx, ctx);
      const open = await tx.commercialChangeRequest.findMany({ where: { action_type: 'POLICY_ACTIVATE', state: { in: [...COMMERCIAL_OPEN_STATES] } }, select: { id: true, state: true, payload: true } });
      const lockedBy = open.find((r) => (r.payload as Record<string, unknown> | null)?.['policy_version_id'] === id);
      if (lockedBy !== undefined) {
        throw new CommercialChangeRequestError('STATE_INVALID', 'the draft is under an open activation request', { reason: 'policy_version_locked', open_request_id: lockedBy.id, open_state: lockedBy.state });
      }
      const before = this.strict(row.content);
      const patch = input.content ?? {};
      const unknown = Object.keys(patch).filter((k) => !(POLICY_EDITABLE_KEYS as readonly string[]).includes(k));
      if (unknown.length > 0) {
        throw new CommercialChangeRequestError('INVALID_INPUT', 'these policy settings cannot be edited', { reason: 'policy_key_not_editable', keys: unknown });
      }
      const proposed: Record<string, unknown> = { ...before, ...patch };
      const rangeErrors = policyRangeErrors(proposed);
      if (rangeErrors.length > 0) throw new CommercialChangeRequestError('INVALID_INPUT', rangeErrors.join('; '), { reason: 'policy_value_out_of_range', errors: rangeErrors });
      const content = this.strict(proposed, 'policy_value_invalid');
      const checksum = commercialPolicyChecksum(content);
      const note = input.note === undefined ? row.note : (input.note ?? '').trim() || null;
      const changed = COMMERCIAL_POLICY_KEYS.filter((k) => (before as unknown as Record<string, unknown>)[k] !== (content as unknown as Record<string, unknown>)[k]);
      const updated = await tx.commercialPolicyVersion.update({ where: { id }, data: { content: content as object, content_checksum: checksum, note } });
      await this.appendAudit(
        tx,
        actor,
        roles,
        'COMMERCIAL_POLICY_DRAFT_UPDATED',
        id,
        {
          version_number: row.version_number,
          changed_keys: changed,
          before: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
          after: Object.fromEntries(changed.map((k) => [k, (content as unknown as Record<string, unknown>)[k]])),
          note_changed: note !== row.note,
          content_checksum: checksum,
        },
        ctx,
      );
      return updated as CommercialPolicyVersionRow;
    });
  }

  private strict(raw: unknown, reason = 'policy_source_malformed'): CommercialPolicyContent {
    try {
      return parseCommercialPolicyContent(raw);
    } catch (e) {
      const errors = e instanceof CommercialPolicyUnavailableError ? e.errors : [String((e as Error).message)];
      throw new CommercialChangeRequestError('INVALID_INPUT', errors.join('; ') || 'invalid policy content', { reason, errors });
    }
  }

  private async requireAuthor(tx: Tx, actor: CommercialActor, ctx: CommercialCallContext): Promise<string[]> {
    if (actor.actor_kind !== 'user') throw new CommercialChangeRequestError('NOT_HUMAN', 'only a user principal can author a policy draft');
    const live = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id, true);
    if (!live.role_keys.some((r) => (POLICY_AUTHOR_ROLES as readonly string[]).includes(r))) {
      throw new CommercialChangeRequestError('REQUESTER_ROLE_MISSING', 'authoring a policy draft requires the platform_owner or finance_admin role', { required_role: [...POLICY_AUTHOR_ROLES] });
    }
    return [...live.role_keys];
  }

  private async appendAudit(tx: Tx, actor: CommercialActor, roles: readonly string[], event_type: string, version_id: string, payload: Record<string, unknown>, ctx: CommercialCallContext): Promise<void> {
    await this.audit.append(
      {
        actor: { id: actor.user_id, type: 'user', role_keys: roles },
        event_type,
        subject: `commercial_policy_version:${version_id}`,
        policy_version_id: version_id,
        payload,
        correlation_id: ctx.correlation_id,
      },
      tx,
    );
  }
}

/** Re-exported so callers can name the POLICY_ACTIVATE snapshot key without importing the model. */
export { POLICY_TARGET_CHECKSUM_KEY };
