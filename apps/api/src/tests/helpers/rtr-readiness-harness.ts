import { randomUUID } from 'node:crypto';

import type { DocumentsRepository } from '@aramo/documents';
import type { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';

import {
  DocumentReadinessGate,
  type RequisitionCompanyIdResolver,
} from '../../rtr/document-readiness.gate.js';

// RTR effective-policy readiness — shared test harness. The ONE canonical
// interpretation of "is RTR required here" lives in DocumentReadinessGate
// (applicability = effective client-submittal-policy `rtr_present` disposition
// REQUIRED, NOT a DocumentRequirement row). Every integration spec that used to
// make RTR required by creating a DocumentRequirement now publishes a policy
// through this one helper — never four independently written setups.

// A company-id resolver that always resolves null. Sufficient whenever the RTR
// requirement is published at TENANT scope (the TENANT layer merges regardless of
// company_id), which is how the gating-precondition specs set RTR = required.
export const nullCompanyIdResolver: RequisitionCompanyIdResolver = {
  findCompanyId: async () => null,
};

// A policy-service stub for integration specs that want to drive RTR applicability
// WITHOUT standing up the policy_store schema + gateway (the real merge/floor/compiler
// path is proven by the client-submittal-policy lib specs and submit-talent's CSP
// integration tests). resolveEffective returns, per requisition:
//   - an rtr_present REQUIRED definition when the id is in requiredRequisitionIds;
//   - an rtr_present NOT_REQUIRED definition when it is in notRequiredRequisitionIds
//     (the explicit relaxation — distinct from an ungoverned null);
//   - null otherwise (UNGOVERNED — no published policy).
// The gate consumes ONLY resolveEffective, so this is a faithful seam.
export function rtrPolicyStub(
  requiredRequisitionIds: ReadonlySet<string>,
  notRequiredRequisitionIds: ReadonlySet<string> = new Set<string>(),
): ClientSubmittalPolicyService {
  const def = (disposition: 'REQUIRED' | 'NOT_REQUIRED') => ({
    requirements: [{ key: 'rtr_present', disposition }],
    layers: [],
    composite_version: 'stub',
  });
  return {
    resolveEffective: async (_tenant: string, ctx: { requisition_id: string | null }) => {
      const id = ctx.requisition_id ?? '';
      if (requiredRequisitionIds.has(id)) return def('REQUIRED');
      if (notRequiredRequisitionIds.has(id)) return def('NOT_REQUIRED');
      return null;
    },
  } as unknown as ClientSubmittalPolicyService;
}

// Construct the gate the way the composition root does, but with a test-supplied
// documents repo, policy service, and company-id resolver.
export function makeDocumentReadinessGate(args: {
  documents: DocumentsRepository;
  policy: ClientSubmittalPolicyService;
  companyId?: RequisitionCompanyIdResolver;
}): DocumentReadinessGate {
  return new DocumentReadinessGate(args.documents, args.policy, args.companyId ?? nullCompanyIdResolver);
}

// Publish an effective policy that makes RTR REQUIRED for the given scope (TENANT
// by default). After this, the gate's isRtrRequired returns true — the precondition
// that the board / qualification / submittal-readiness / submit assertions depend on.
export async function publishRtrRequired(
  policy: ClientSubmittalPolicyService,
  args: {
    tenant_id: string;
    scope?: 'TENANT' | 'CLIENT' | 'REQUISITION';
    scope_ref?: string | null;
    published_by?: string;
    version?: string;
  },
): Promise<void> {
  await policy.publish({
    tenant_id: args.tenant_id,
    scope: args.scope ?? 'TENANT',
    scope_ref: args.scope_ref ?? null,
    version: args.version ?? '1.0.0',
    definition: {
      requirements: [
        { key: 'rtr_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' },
      ],
    },
    published_by: args.published_by ?? randomUUID(),
  });
}
