import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  SubmittalAuthorityValue,
  SubmittalPolicyReasonValue,
  SubmittalWindowStatusValue,
} from './submittal-eligibility-vocab.js';
import type { SubmittalPolicyInputs } from './submittal-eligibility.port.js';

// Policy-ADMIN repository (L8-B1, non-atomic half). Owns reads + governed writes
// of RequisitionSubmittalPolicy and the append-only SubmittalPolicyEvent history
// (base R13, TE-4/TE-5). The ATOMIC client-submittal command (consumption +
// submittal + pipeline mirror) is NOT here — it runs at the apps/api
// orchestration boundary under one interactive tx (Approach A, §6).
//
// Guarded by `submittal-policy:write` at the controller (base R-OQB).

export interface SetPolicyInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly submittal_deadline?: Date | null;
  readonly shortlisting_deadline?: Date | null;
  readonly submittal_limit?: number | null;
  readonly submittal_authority: SubmittalAuthorityValue;
  readonly manual_override?: SubmittalWindowStatusValue | null;
  readonly submittal_reason?: SubmittalPolicyReasonValue | null;
  readonly actor_id: string;
  readonly origin: string;
  readonly requestId: string;
  /** Expected version for optimistic concurrency (TE-3); omit on first create. */
  readonly expected_version?: number;
}

export interface PolicyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly submittal_deadline: Date | null;
  readonly shortlisting_deadline: Date | null;
  readonly submittal_limit: number | null;
  readonly submittal_authority: SubmittalAuthorityValue;
  readonly manual_override: SubmittalWindowStatusValue | null;
  readonly submittal_reason: SubmittalPolicyReasonValue | null;
  readonly version: number;
}

@Injectable()
export class SubmittalPolicyRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('SubmittalPolicyRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  /** The persisted INPUTS the eligibility port needs (null across the board when
   * no policy row exists ⇒ default OPEN). */
  async getInputs(
    tenant_id: string,
    requisition_id: string,
  ): Promise<SubmittalPolicyInputs> {
    const row = await this.prisma.requisitionSubmittalPolicy.findUnique({
      where: { tenant_id_requisition_id: { tenant_id, requisition_id } },
    });
    if (row === null) {
      return {
        submittal_deadline: null,
        submittal_limit: null,
        manual_override: null,
        submittal_authority: 'ARAMO',
      };
    }
    return {
      submittal_deadline: row.submittal_deadline,
      submittal_limit: row.submittal_limit,
      manual_override:
        row.manual_override as SubmittalWindowStatusValue | null,
      submittal_authority: row.submittal_authority as SubmittalAuthorityValue,
    };
  }

  async getPolicy(
    tenant_id: string,
    requisition_id: string,
  ): Promise<PolicyRow | null> {
    const row = await this.prisma.requisitionSubmittalPolicy.findUnique({
      where: { tenant_id_requisition_id: { tenant_id, requisition_id } },
    });
    return row === null ? null : (row as unknown as PolicyRow);
  }

  /** Upsert the policy (version-CAS on update) + append a policy event, atomically. */
  async setPolicy(input: SetPolicyInput): Promise<PolicyRow> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.requisitionSubmittalPolicy.findUnique({
        where: {
          tenant_id_requisition_id: {
            tenant_id: input.tenant_id,
            requisition_id: input.requisition_id,
          },
        },
      });

      if (
        existing !== null &&
        input.expected_version !== undefined &&
        existing.version !== input.expected_version
      ) {
        throw new AramoError(
          'REQUISITION_VERSION_CONFLICT',
          'Submittal policy was modified concurrently',
          409,
          {
            requestId: input.requestId,
            details: {
              requisition_id: input.requisition_id,
              expected_version: input.expected_version,
              actual_version: existing.version,
            },
          },
        );
      }

      const data = {
        submittal_deadline: input.submittal_deadline ?? null,
        shortlisting_deadline: input.shortlisting_deadline ?? null,
        submittal_limit: input.submittal_limit ?? null,
        submittal_authority: input.submittal_authority,
        manual_override: input.manual_override ?? null,
        submittal_reason: input.submittal_reason ?? null,
      };

      const saved =
        existing === null
          ? await tx.requisitionSubmittalPolicy.create({
              data: {
                tenant_id: input.tenant_id,
                requisition_id: input.requisition_id,
                ...data,
              },
            })
          : await tx.requisitionSubmittalPolicy.update({
              where: { id: existing.id },
              data: { ...data, version: { increment: 1 } },
            });

      await tx.submittalPolicyEvent.create({
        data: {
          tenant_id: input.tenant_id,
          requisition_id: input.requisition_id,
          previous_status:
            (existing?.manual_override as SubmittalWindowStatusValue | null) ??
            null,
          next_status: input.manual_override ?? null,
          authority: input.submittal_authority,
          reason: input.submittal_reason ?? null,
          actor_id: input.actor_id,
          origin: input.origin,
          effective_at: new Date(),
        },
      });

      this.logger.log({
        event: 'submittal_policy_set',
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
        authority: input.submittal_authority,
      });

      return saved as unknown as PolicyRow;
    });
  }
}
