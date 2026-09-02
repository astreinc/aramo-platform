import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { RequirementInstanceRepository, type InstanceView } from '@aramo/pre-start-requirement';

// Track 3 / E2 — the waiver AUTHORIZATION floor (apps/api). Independent from the
// domain waiver floor in the lib. The two controls never substitute for each other:
//
//   RBAC (here):   may this PRINCIPAL attempt to waive THIS requirement?
//                  A blocking requirement demands pre_start_requirement:waive_blocking;
//                  a non-blocking (advisory) one demands waive_advisory. The choice
//                  is DATA-dependent (the instance's blocking flag), so it cannot be
//                  a static route scope — it is decided here, BEFORE any mutation.
//   Domain (lib):  may this requirement EVER be waived under its FROZEN rule?
//                  RequirementInstanceRepository.waive refuses NOT_WAIVABLE
//                  unconditionally against the SNAPSHOTTED waiver_mode.
//
// waive_blocking carries ZERO default RoleScope grants (fail-closed): no seeded
// role — recruiter, account manager, tenant admin/owner, auditor, super_admin —
// holds it, so a blocking waiver is denied here for every default principal. That
// is intentional, not a defect. Platform authority (super_admin / platform tokens)
// does NOT bypass tenant compliance authority: the scope check is uniform.
const WAIVE_BLOCKING_SCOPE = 'pre_start_requirement:waive_blocking';
const WAIVE_ADVISORY_SCOPE = 'pre_start_requirement:waive_advisory';

export interface WaiveRequest {
  authority: string;
  justification: string;
  source?: string;
  // L5-P5 — optional supporting evidence pointer for the waiver.
  evidence_reference?: string;
}

@Injectable()
export class PreStartWaiverService {
  constructor(private readonly requirements: RequirementInstanceRepository) {}

  async waive(
    auth: AuthContextType,
    requirement_instance_id: string,
    body: WaiveRequest,
    requestId: string,
  ): Promise<InstanceView> {
    const instance = await this.requirements.findById(auth.tenant_id, requirement_instance_id);
    if (instance === null) {
      throw new AramoError('NOT_FOUND', 'PreStartRequirementInstance not found', 404, {
        requestId,
        details: { requirement_instance_id, reason: 'instance_not_found' },
      });
    }

    // RBAC floor — evaluated BEFORE the domain mutation. Data-dependent on blocking.
    const required = instance.blocking ? WAIVE_BLOCKING_SCOPE : WAIVE_ADVISORY_SCOPE;
    if (!auth.scopes.includes(required)) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        `waiving this requirement requires the ${required} scope`,
        403,
        {
          requestId,
          details: { requirement_instance_id, required_scope: required, blocking: instance.blocking },
        },
      );
    }

    // Domain floor — snapshot-anchored NOT_WAIVABLE + authority/mode + status legality.
    return this.requirements.waive(
      {
        tenant_id: auth.tenant_id,
        requirement_instance_id,
        authority: body.authority,
        actor_id: auth.sub,
        actor_type: auth.actor_kind,
        justification: body.justification,
        source: body.source,
        evidence_reference: body.evidence_reference,
      },
      requestId,
    );
  }
}
