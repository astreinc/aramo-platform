import { Injectable, Logger } from '@nestjs/common';
import {
  DefinitionSetRepository,
  MaterializationIntentRepository,
  RequirementInstanceRepository,
  type ScopeSelector,
  type ScopeTypeValue,
} from '@aramo/pre-start-requirement';

// Track 3 / E2 — the first-entry materialize saga + reconciler (§14 A2, §1.5).
//
// RECONCILE_INTERVAL_MS = 60_000 (60s). Rationale: in the normal path materialize
// runs SYNCHRONOUSLY inside the saga right after the placement transition commits,
// so the window is sub-second and the reconciler never sees it. The reconciler
// exists only for the rare case where the process dies between the transition
// commit and that synchronous call. A tighter interval buys almost nothing (the
// stuck-time it saves is seconds on a rare event) while adding steady poll load; a
// looser one lets a genuinely-stuck placement sit "preparing" too long. 60s bounds
// worst-case stuck-time to ~1 minute at negligible cost. Wire reconcile() to a
// scheduler at this interval (no scheduler infra exists in apps/api yet — the
// method is exposed and directly tested).
export const RECONCILE_INTERVAL_MS = 60_000;

// MAX_MATERIALIZE_ATTEMPTS = 5. A reconciler that retries forever is a silent
// backlog. After 5 transient failures an intent is QUARANTINED: retries stop, the
// reason is surfaced (log + metric hook), and the placement stays gated —
// READY_TO_START remains refused (materialization_absent) because no snapshot
// exists. Fail-closed and VISIBLE, never silently ready. A config failure (no
// published definition set) is not transient, so it quarantines IMMEDIATELY rather
// than burning 5 attempts; recovery is: publish a TENANT set, then an operator
// re-queues the quarantined intent.
export const MAX_MATERIALIZE_ATTEMPTS = 5;

export interface MaterializeSagaInput {
  tenant_id: string;
  placement_process_id: string;
  scope: ScopeTypeValue;
  scope_ref_id: string;
  // L5-P5 — the layered precedence context (TENANT baseline is scope/scope_ref_id;
  // CLIENT/REQUISITION augment/override). Either may be null (that layer is skipped).
  client_id: string | null;
  requisition_id: string | null;
}

// The system actor recorded on operational log lines (materialization is not a
// human-consequential action — it appends no audit rows, only instances).
@Injectable()
export class PreStartMaterializationService {
  private readonly logger = new Logger(PreStartMaterializationService.name);

  constructor(
    private readonly sets: DefinitionSetRepository,
    private readonly requirements: RequirementInstanceRepository,
    private readonly intents: MaterializationIntentRepository,
  ) {}

  // The saga step — invoked immediately after the placement is created (born at
  // PRE_START, downstream of an accepted Offer aggregate)
  // (NOT on BLOCKED -> PRE_START recovery: materialize is idempotent, but the saga
  // fires once on first entry; recovery re-entry relies on the existing snapshot).
  // Records a durable intent (so the reconciler can recover from process death),
  // then attempts materialization once synchronously.
  async materializeForPlacement(input: MaterializeSagaInput): Promise<void> {
    const selector: ScopeSelector = { scope: input.scope, scope_ref_id: input.scope_ref_id };
    const intent = await this.intents.ensureIntent(input.tenant_id, input.placement_process_id, selector, {
      client_id: input.client_id,
      requisition_id: input.requisition_id,
    });
    // A resolved/quarantined intent is terminal — do not re-attempt.
    if (intent.status !== 'pending') {
      return;
    }
    await this.attempt(intent.id, intent.attempts, input);
  }

  // One materialization attempt against a recorded intent, applying the
  // resolve / retry / quarantine policy.
  private async attempt(intentId: string, priorAttempts: number, input: MaterializeSagaInput): Promise<void> {
    const requestId = `pre-start-materialize:${input.placement_process_id}`;
    try {
      await this.intents.recordAttempt(intentId);
      // L5-P5 — resolve the EFFECTIVE layered config (TENANT -> CLIENT -> REQUISITION)
      // and materialize the merged snapshot. Null when no layer has an open set.
      const set = await this.sets.resolveEffective(
        input.tenant_id,
        { client_id: input.client_id, requisition_id: input.requisition_id },
        requestId,
      );

      // no published set — a CONFIG failure, not transient. Quarantine immediately.
      if (set === null) {
        await this.intents.markQuarantined(intentId, 'no_published_definition_set');
        this.logger.warn(
          `pre-start materialization QUARANTINED (no_published_definition_set) placement=${input.placement_process_id} tenant=${input.tenant_id}`,
        );
        return;
      }

      await this.requirements.materialize(input.tenant_id, input.placement_process_id, set);
      await this.intents.markResolved(intentId);
    } catch (err) {
      const attempts = priorAttempts + 1;
      if (attempts >= MAX_MATERIALIZE_ATTEMPTS) {
        await this.intents.markQuarantined(intentId, `max_attempts_exceeded:${String(err)}`);
        this.logger.error(
          `pre-start materialization QUARANTINED (max attempts=${attempts}) placement=${input.placement_process_id} tenant=${input.tenant_id}: ${String(err)}`,
        );
        return;
      }
      // Transient — stays pending for the next reconcile tick.
      this.logger.warn(
        `pre-start materialization attempt ${attempts} failed placement=${input.placement_process_id}: ${String(err)}`,
      );
    }
  }

  // The reconciler tick — drains pending intents. Wire to a scheduler at
  // RECONCILE_INTERVAL_MS. Returns the number processed for operational visibility.
  async reconcile(limit = 50): Promise<{ processed: number }> {
    const due = await this.intents.listPending(limit);
    for (const intent of due) {
      await this.attempt(intent.id, intent.attempts, {
        tenant_id: intent.tenant_id,
        placement_process_id: intent.placement_process_id,
        scope: intent.scope,
        scope_ref_id: intent.scope_ref_id,
        client_id: intent.client_id,
        requisition_id: intent.requisition_id,
      });
    }
    return { processed: due.length };
  }
}
