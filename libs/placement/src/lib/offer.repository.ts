import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import { insertPolicyDecisionRecordInTx } from '@aramo/policy-store';

import { PrismaService } from './prisma/prisma.service.js';
import {
  governingOfferAction,
  OFFER_INITIAL_STATE,
  type OfferState,
} from './lifecycle/offer-lifecycle.js';
import { OfferTransitionPolicyService } from './policy/offer-transition-policy.service.js';

export interface OfferView {
  readonly id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: OfferState;
  readonly proposed_start_date: string | null;
  readonly offer_expires_at: string | null;
  readonly client_offer_reference: string | null;
  readonly offer_terms_summary: string | null;
  readonly decline_reason: string | null;
  readonly created_at: string;
}

export interface CreateOfferInput {
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly proposed_start_date?: string | null;
  readonly offer_expires_at?: string | null;
  readonly client_offer_reference?: string | null;
  readonly offer_terms_summary?: string | null;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export interface TransitionOfferInput {
  readonly tenant_id: string;
  readonly id: string;
  readonly to_state: OfferState;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly proposed_start_date?: string | null;
  readonly offer_expires_at?: string | null;
  readonly client_offer_reference?: string | null;
  readonly offer_terms_summary?: string | null;
  readonly decline_reason?: string | null;
}

type OfferRow = {
  id: string; tenant_id: string; submittal_id: string; requisition_id: string;
  talent_record_id: string; state: OfferState;
  proposed_start_date: Date | null; offer_expires_at: Date | null;
  client_offer_reference: string | null; offer_terms_summary: string | null;
  decline_reason: string | null; created_at: Date;
};

function toView(r: OfferRow): OfferView {
  return {
    id: r.id, tenant_id: r.tenant_id, submittal_id: r.submittal_id,
    requisition_id: r.requisition_id, talent_record_id: r.talent_record_id,
    state: r.state,
    proposed_start_date: r.proposed_start_date === null ? null : r.proposed_start_date.toISOString().slice(0, 10),
    offer_expires_at: r.offer_expires_at?.toISOString() ?? null,
    client_offer_reference: r.client_offer_reference,
    offer_terms_summary: r.offer_terms_summary,
    decline_reason: r.decline_reason,
    created_at: r.created_at.toISOString(),
  };
}

// Offer aggregate repository (D5). Create a DRAFT offer, read one, and drive its
// governed transitions. Legality is enforced in DEPTH: governingOfferAction is
// the structured pre-check, the ADR-0024 offer-lifecycle policy is the fail-
// closed authority (no package = DENY), and the DB lifecycle trigger is the
// backstop (illegal edge / one-live / immutable-column → check_violation).
@Injectable()
export class OfferRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitionPolicy: OfferTransitionPolicyService,
  ) {}

  async findById(tenant_id: string, id: string): Promise<OfferView | null> {
    const row = (await this.prisma.offer.findFirst({ where: { tenant_id, id } })) as OfferRow | null;
    return row === null ? null : toView(row);
  }

  // D7 (LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0, R-DISCOVERY) — the offer
  // LIST/filter read for the recruiter surface. Set-based; visibility-scoped:
  // only offers whose requisition_id is in the actor's visible-requisition set
  // (`null` ⇒ see_all_requisition ⇒ unrestricted). The three filters
  // (submittal / requisition / talent) are optional and AND-ed. Recruiters
  // reach it by (requisition_id, talent_record_id) — the one-live DB trigger
  // guarantees ≤1 NON-terminal offer per (tenant, submittal), so the container
  // can pick the current offer deterministically.
  async list(input: {
    tenant_id: string;
    submittal_id?: string;
    requisition_id?: string;
    talent_record_id?: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    limit?: number;
  }): Promise<OfferView[]> {
    const limit = Math.min(input.limit ?? 50, 200);
    const where: Record<string, unknown> = { tenant_id: input.tenant_id };
    if (input.visible_requisition_ids !== null) {
      where['requisition_id'] = {
        in: Array.from(input.visible_requisition_ids),
      };
    }
    if (input.requisition_id !== undefined) {
      // narrow to one requisition; AND with the visibility set.
      if (
        input.visible_requisition_ids !== null &&
        !input.visible_requisition_ids.has(input.requisition_id)
      ) {
        return [];
      }
      where['requisition_id'] = input.requisition_id;
    }
    if (input.submittal_id !== undefined) {
      where['submittal_id'] = input.submittal_id;
    }
    if (input.talent_record_id !== undefined) {
      where['talent_record_id'] = input.talent_record_id;
    }
    const rows = (await this.prisma.offer.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    })) as OfferRow[];
    return rows.map(toView);
  }

  async create(input: CreateOfferInput): Promise<OfferView> {
    const id = uuidv7();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = (await tx.offer.create({
          data: {
            id,
            tenant_id: input.tenant_id,
            submittal_id: input.submittal_id,
            requisition_id: input.requisition_id,
            talent_record_id: input.talent_record_id,
            state: OFFER_INITIAL_STATE,
            proposed_start_date: input.proposed_start_date ? new Date(input.proposed_start_date) : null,
            offer_expires_at: input.offer_expires_at ? new Date(input.offer_expires_at) : null,
            client_offer_reference: input.client_offer_reference ?? null,
            offer_terms_summary: input.offer_terms_summary ?? null,
          },
        })) as OfferRow;
        await tx.offerEvent.create({
          data: {
            id: uuidv7(), tenant_id: input.tenant_id, offer_id: id,
            event_type: 'state_transition',
            event_payload: { previous_state: null, next_state: OFFER_INITIAL_STATE, actor_id: input.actor_id },
          },
        });
        await tx.offerOutboxEvent.create({
          data: {
            id: uuidv7(), tenant_id: input.tenant_id, event_type: 'offer.created',
            event_payload: { offer_id: id, submittal_id: input.submittal_id, state: OFFER_INITIAL_STATE },
          },
        });
        return created;
      });
      return toView(row);
    } catch (e) {
      if (isCheckViolation(e)) {
        throw new AramoError(
          'OFFER_ALREADY_LIVE',
          'A live offer already exists for this submittal',
          409,
          { requestId: input.correlation_id, details: { submittal_id: input.submittal_id } },
        );
      }
      throw e;
    }
  }

  async transition(input: TransitionOfferInput): Promise<OfferView> {
    const existing = (await this.prisma.offer.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    })) as OfferRow | null;
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'Offer not found in tenant', 404, {
        requestId: input.correlation_id, details: { id: input.id },
      });
    }
    const from = existing.state;
    const action = governingOfferAction(from, input.to_state);
    if (action === null) {
      throw new AramoError(
        'OFFER_ILLEGAL_TRANSITION',
        `Offer transition ${from} -> ${input.to_state} is not a legal edge`,
        409,
        { requestId: input.correlation_id, details: { from, to: input.to_state } },
      );
    }

    // Fail-closed policy governance (R-GOVERNED): evaluate BEFORE any write.
    const outcome = await this.transitionPolicy.decide({
      tenant_id: input.tenant_id,
      action,
      from_state: from,
      scopes: input.scopes,
      actor_id: input.actor_id,
      origin: 'ui',
      correlation_id: input.correlation_id,
    });
    if (outcome.disposition === 'DENY') {
      await this.prisma.$transaction((tx) => insertPolicyDecisionRecordInTx(tx, outcome.provenance));
      throw new AramoError('POLICY_DENIED', 'The offer lifecycle policy denied this transition', 403, {
        requestId: input.correlation_id, details: { reason_code: outcome.reason_code },
      });
    }

    const data: Record<string, unknown> = { state: input.to_state };
    if (input.proposed_start_date !== undefined) data['proposed_start_date'] = input.proposed_start_date === null ? null : new Date(input.proposed_start_date);
    if (input.offer_expires_at !== undefined) data['offer_expires_at'] = input.offer_expires_at === null ? null : new Date(input.offer_expires_at);
    if (input.client_offer_reference !== undefined) data['client_offer_reference'] = input.client_offer_reference;
    if (input.offer_terms_summary !== undefined) data['offer_terms_summary'] = input.offer_terms_summary;
    if (input.decline_reason !== undefined) data['decline_reason'] = input.decline_reason;

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = (await tx.offer.update({ where: { id: input.id }, data })) as OfferRow;
      await tx.offerEvent.create({
        data: {
          id: uuidv7(), tenant_id: input.tenant_id, offer_id: input.id,
          event_type: 'state_transition',
          event_payload: { previous_state: from, next_state: input.to_state, action, actor_id: input.actor_id },
        },
      });
      await tx.offerOutboxEvent.create({
        data: {
          id: uuidv7(), tenant_id: input.tenant_id, event_type: `offer.${action.toLowerCase()}`,
          event_payload: { offer_id: input.id, previous_state: from, next_state: input.to_state },
        },
      });
      await insertPolicyDecisionRecordInTx(tx, outcome.provenance);
      return updated;
    });
    return toView(row);
  }
}

function isCheckViolation(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e);
  return /check_violation|at most one live offer/i.test(msg);
}
