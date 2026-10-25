import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { BillingCommandConfirmation } from '../billing/billing-provider-command.js';
import { BILLING_COMMAND_UNCONFIRMED_STATES, isAdjustmentCommandKind } from '../billing/billing-provider-command.js';
import type { ProviderAdjustmentEffect } from '../billing/billing-provider.port.js';
import type { PrismaService } from '../prisma/prisma.service.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import { adjustmentAuditEvent } from './commercial-billing-adjustment.js';
import { isBillingAdjustmentAction } from './commercial-change-request.js';
import type { CommercialChangeRequestRow } from './commercial-change-request.service.js';

// CCP-C4 (PBD §5.2 row C4; Conversion Rule C-22, C-23) — the in-transaction completion of a
// billing adjustment. Called ONLY from the transaction that applies the provider-confirmed effect
// (SubscriptionLifecycleService.syncAdjustmentCommand: a verified webhook through the inbox, or a
// provider re-fetch), under the shared billing lock. In that one transaction: the command becomes
// CONFIRMED, the append-only CommercialBillingAdjustment record is written, and the request moves
// APPLYING → APPLIED with its audit. Never on the command's own commit, never before the provider
// shows the effect (C-23). The DB guard (union block "CCP-C4") refuses APPLIED without the record
// and the confirmed command.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

const SYSTEM = { id: null, type: 'system' as const, role_keys: [] as string[] };
const SUBJECT = (id: string): string => `commercial_change_request:${id}`;

export interface CommercialBillingAdjustmentRow {
  id: string;
  change_request_id: string;
  action_type: string;
  operation: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  provider: string;
  provider_target_ref: string;
  provider_object_ref: string | null;
  amount_minor: number | null;
  currency: string | null;
  discount_bps: number | null;
  compensates_change_request_id: string | null;
  command_id: string;
  confirmation_source: string;
  confirmation_event_id: string | null;
  attempt: number;
  requested_by: string;
  applied_at: Date;
}

export type AdjustmentConfirmOutcome = { outcome: 'APPLIED'; change_request_id: string; adjustment_id: string } | { outcome: 'IGNORED'; detail: string };

@Injectable()
export class CommercialBillingAdjustmentLedger {
  constructor(private readonly audit: CommercialAuditRepository) {}

  /**
   * In the caller's transaction (billing lock held): the provider shows `effect` for `command_id`.
   * Confirm the command, record the adjustment and apply the request. Idempotent: an already
   * confirmed command or applied request is IGNORED.
   */
  async confirmInTx(
    tx: Tx,
    q: { command_id: string; effect: ProviderAdjustmentEffect; confirmation: BillingCommandConfirmation; at: Date; correlation_id: string },
  ): Promise<AdjustmentConfirmOutcome> {
    const cmd = await tx.billingProviderCommand.findUnique({ where: { id: q.command_id } });
    if (cmd === null || !isAdjustmentCommandKind(cmd.command_kind)) return { outcome: 'IGNORED', detail: 'not a billing-adjustment command' };
    if (!(BILLING_COMMAND_UNCONFIRMED_STATES as readonly string[]).includes(cmd.state)) return { outcome: 'IGNORED', detail: `command ${cmd.state}` };
    if (!q.effect.present) return { outcome: 'IGNORED', detail: 'the provider does not show the effect yet' };
    await tx.$executeRawUnsafe(`SELECT 1 FROM subscription."CommercialChangeRequest" WHERE id = $1::uuid FOR UPDATE`, cmd.change_request_id);
    const req = (await tx.commercialChangeRequest.findUniqueOrThrow({ where: { id: cmd.change_request_id } })) as CommercialChangeRequestRow;
    if (!isBillingAdjustmentAction(req.action_type)) return { outcome: 'IGNORED', detail: `${req.action_type} is not a billing adjustment` };
    // Invariant (DB guard): a billing adjustment with an unconfirmed command is APPLYING (it never
    // becomes APPLY_FAILED or APPLY_EXPIRED while its command is in flight).
    if (req.state !== 'APPLYING') return { outcome: 'IGNORED', detail: `request ${req.state}` };

    const params = (cmd.params ?? {}) as Record<string, unknown>;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const object_ref = cmd.provider_object_ref ?? q.effect.object_ref;
    // 1. The command is CONFIRMED by the provider-confirmed effect (C-23), in this transaction.
    await tx.billingProviderCommand.update({
      where: { id: cmd.id },
      data: {
        state: 'CONFIRMED',
        confirmed_at: q.at,
        confirmation_source: q.confirmation.source,
        confirmation_event_id: q.confirmation.event_id,
        lease_until: null,
        next_attempt_at: null,
        ...(cmd.provider_object_ref === null && object_ref !== null ? { provider_object_ref: object_ref } : {}),
        updated_at: q.at,
      },
    });
    // 2. The append-only application record of the Stripe-side effect.
    const adjustment_id = uuidv7();
    await tx.commercialBillingAdjustment.create({
      data: {
        id: adjustment_id,
        change_request_id: req.id,
        action_type: req.action_type,
        operation: cmd.command_kind,
        tenant_id: cmd.tenant_id,
        product_key: cmd.product_key,
        subscription_id: String(params['subscription_id'] ?? payload['subscription_id'] ?? ''),
        provider: cmd.provider,
        provider_target_ref: cmd.target_ref,
        provider_object_ref: object_ref,
        amount_minor: typeof payload['amount_minor'] === 'number' ? (payload['amount_minor'] as number) : null,
        currency: typeof payload['currency'] === 'string' ? (payload['currency'] as string) : null,
        discount_bps: typeof payload['discount_bps'] === 'number' ? (payload['discount_bps'] as number) : null,
        compensates_change_request_id: typeof payload['compensates_change_request_id'] === 'string' ? (payload['compensates_change_request_id'] as string) : null,
        command_id: cmd.id,
        confirmation_source: q.confirmation.source,
        confirmation_event_id: q.confirmation.event_id,
        attempt: req.apply_attempts,
        requested_by: req.requested_by,
        applied_at: q.at,
      },
    });
    // 3. APPLIED only now (C-23), with its audit. No amount in the audit body (Finance interim).
    const approvals = await tx.commercialApproval.findMany({ where: { change_request_id: req.id }, orderBy: { step_index: 'asc' } });
    const base = { tenant_id: cmd.tenant_id, change_request_id: req.id, policy_version_id: req.policy_version_id, correlation_id: q.correlation_id };
    await this.audit.append(
      {
        actor: SYSTEM,
        event_type: adjustmentAuditEvent(req.action_type, 'CONFIRMED'),
        subject: `billing_adjustment:${adjustment_id}`,
        payload: { action_type: req.action_type, product_key: req.product_key, operation: cmd.command_kind, command_id: cmd.id, idempotency_key: cmd.idempotency_key, provider_object_ref: object_ref, confirmation_source: q.confirmation.source, confirmation_event_id: q.confirmation.event_id },
        ...base,
      },
      tx,
    );
    await this.audit.append(
      {
        actor: SYSTEM,
        event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLIED',
        subject: SUBJECT(req.id),
        payload: {
          action_type: req.action_type,
          product_key: req.product_key,
          outcome: 'APPLIED',
          attempt: req.apply_attempts,
          requested_by: req.requested_by,
          reason: req.reason,
          policy_checksum: req.policy_checksum,
          approvals: approvals.map((a) => ({ approval_id: a.id, step_index: a.step_index, approver_user_id: a.approver_user_id, attestation_id: a.attestation_id, approved_at: a.created_at.toISOString() })),
          adjustment_id,
          operation: cmd.command_kind,
          provider_confirmed: true,
          effective_at: q.at.toISOString(),
        },
        ...base,
      },
      tx,
    );
    await tx.commercialChangeRequest.update({ where: { id: req.id }, data: { state: 'APPLIED', applied_at: q.at, updated_at: q.at } });
    return { outcome: 'APPLIED', change_request_id: req.id, adjustment_id };
  }
}
