import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  validateContradictionResolutionRequest,
  type ContradictionResolutionResponse,
} from '@aramo/intelligence-contracts';

import { assertionVisibleTo, crossTenantReadEnabled, isOwnAssertion, reconciledPairs, tenantViewAssertions, tenantViewIdentifiers } from '../access/tenant-view.js';
import { survivingSubject } from '../identity/identity-resolution.service.js';
import type { IngestPrincipal } from '../ingest/talent-ingest.service.js';
import {
  PROJECTION_TRIGGER,
  artifactSupportedIds,
  availabilityFreshnessDays,
  toProjectionAssertion,
  toProjectionIdentifier,
  type ProjectionTrigger,
} from '../projection/projection.service.js';
import { computeProjection } from '../projection/projection.js';
import { INTELLIGENCE_UNIT_OF_WORK, type IntelligenceUnitOfWork, type SourceTuple } from '../repositories/types.js';
import { RETIRED_ASSERTION_STATUSES, type AssertionStatus } from '../vocabulary.js';

import { refused, requireActiveReference, tenantActor } from './lifecycle-access.js';

// ATI-SEP-1 T10 M-3 — contradiction resolution (the one human arm on the
// contradiction machinery), addressed through the tenant's own reference tuple.
// Guarded like the legacy resolve: only an assertion CONTRADICTED in the tenant's
// view resolves (else 422 ASSERTION_NOT_CONTRADICTED).
//
//   KEEP    → a RECONCILES link to every contradicting partner in the tenant's view
//             (the projection never pairs them again) + the assertion back to VALID;
//   RETRACT → the assertion REVOKED; only for an assertion the tenant contributed
//             (else 403 RESOLUTION_NOT_PERMITTED).
// Either way an AssertionEvent CONTRADICTION_RESOLVED records the decision, the
// reason and the acting tenant (an enrichment decision of THAT tenant); the
// projection is rebuilt after commit. ATS data is never touched.

@Injectable()
export class ContradictionResolutionService {
  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    @Optional() @Inject(PROJECTION_TRIGGER) private readonly projection?: ProjectionTrigger,
  ) {}

  async resolve(
    tuple: SourceTuple,
    assertionId: string,
    body: unknown,
    principal: IngestPrincipal,
    now: Date = new Date(),
  ): Promise<ContradictionResolutionResponse> {
    const v = validateContradictionResolutionRequest(body);
    if (!v.ok) throw refused('INVALID_REQUEST', v.issues);
    const req = v.value;
    const tenant = { source_system_id: tuple.source_system_id, source_tenant_id: tuple.source_tenant_id };
    const peek = await this.uow.run((repos) => repos.references.findByTuple(tuple));

    const result = await this.uow.run(
      async (repos) => {
        const { subject } = await requireActiveReference(repos, principal, tuple, { entitled: true });
        const cross = crossTenantReadEnabled();
        const assertion = await repos.assertions.findById(assertionId);
        if (
          assertion === null ||
          (await survivingSubject(repos, assertion.subject_id)).id !== subject.id ||
          !assertionVisibleTo(assertion, tenant, cross)
        ) {
          throw refused('NOT_FOUND');
        }
        if ((RETIRED_ASSERTION_STATUSES as readonly string[]).includes(assertion.current_status)) throw refused('ASSERTION_NOT_CONTRADICTED');

        // The tenant's view (the same one the read API shows it).
        const live = tenantViewAssertions(await repos.assertions.listBySubject(subject.id), tenant, cross).filter(
          (a) => !(RETIRED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status),
        );
        const identifiers = tenantViewIdentifiers(await repos.identifiers.listBySubject(subject.id), await repos.references.listBySubject(subject.id), tenant, cross);
        const existingLinks = await repos.assertions.listLinksFor(live.map((a) => a.id));
        const reconciled = reconciledPairs(existingLinks);
        const view = computeProjection(live.map(toProjectionAssertion), identifiers.map(toProjectionIdentifier), {
          now,
          availabilityFreshnessDays: availabilityFreshnessDays(),
          artifactSupported: await artifactSupportedIds(repos, subject.id),
          reconciled,
        });
        if (view.effective_status.get(assertion.id) !== 'CONTRADICTED') throw refused('ASSERTION_NOT_CONTRADICTED');

        const actor = tenantActor(tenant, req.actor);
        const from = assertion.current_status as AssertionStatus;
        const partners = view.contradiction_partners.get(assertion.id) ?? [];
        let to: AssertionStatus = from;
        const reconciledWith: string[] = [];
        if (req.resolution === 'KEEP') {
          for (const p of partners) {
            if (!reconciled.has(`${assertion.id}|${p}`)) {
              await repos.assertions.appendLink({ from_assertion_id: assertion.id, to_assertion_id: p, link_type: 'RECONCILES', actor });
            }
            reconciledWith.push(p);
          }
          // A standing dispute keeps its own axis (DISPUTED); a stored contradiction lifts.
          if (from === 'CONTRADICTED' && (await repos.assertions.transitionStatus(assertion.id, 'CONTRADICTED', 'VALID'))) to = 'VALID';
        } else {
          if (!isOwnAssertion(assertion, tenant)) throw refused('RESOLUTION_NOT_PERMITTED');
          if (!(await repos.assertions.transitionStatus(assertion.id, from, 'REVOKED'))) throw refused('ASSERTION_NOT_CONTRADICTED');
          to = 'REVOKED';
        }
        await repos.assertions.appendEvent({
          assertion_id: assertion.id,
          event_type: 'CONTRADICTION_RESOLVED',
          from_status: from,
          to_status: to,
          actor,
          details: {
            resolution: req.resolution,
            reason: req.reason,
            source_system_id: tenant.source_system_id,
            source_tenant_id: tenant.source_tenant_id,
            reconciled_with: reconciledWith,
          },
        });
        const response: ContradictionResolutionResponse = { assertion_id: assertion.id, resolution: req.resolution, status: to, reconciled_with: reconciledWith };
        return { response, subjectId: subject.id };
      },
      { lockKeys: peek ? [`projection:${peek.subject_id}`] : [] },
    );
    await this.projection?.subjectsChanged([result.subjectId]);
    return result.response;
  }
}
