import { randomUUID } from 'node:crypto';

import type { DocumentsRepository } from '@aramo/documents';
import type { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';

import {
  DocumentReadinessGate,
  type RequisitionCompanyIdResolver,
} from '../../rtr/document-readiness.gate.js';
import { RtrQualifiedTransitionGuard } from '../../rtr/rtr-qualified-transition-guard.module.js';

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
// integration tests). Per requisition:
//   - REQUIRED when the id is in requiredRequisitionIds;
//   - NOT_REQUIRED (explicit relaxation) when it is in notRequiredRequisitionIds;
//   - otherwise `opts.otherwise` — default 'UNRESOLVED' (no published policy: Talent
//     Lifecycle R1–R5 Impl Directive v1.2 §4.1 — never "not required"). A spec that is
//     not ABOUT RTR declares 'NOT_REQUIRED' explicitly, so its intent is visible.
// The gate consumes resolveRequirementSource (and the submit path resolveEffective), so
// both are stubbed consistently.
export function rtrPolicyStub(
  requiredRequisitionIds: ReadonlySet<string>,
  notRequiredRequisitionIds: ReadonlySet<string> = new Set<string>(),
  opts: {
    otherwise?: 'UNRESOLVED' | 'NOT_REQUIRED' | 'REQUIRED';
    // Requisitions that resolve UNRESOLVED even when `otherwise` is NOT_REQUIRED.
    unresolvedRequisitionIds?: ReadonlySet<string>;
  } = {},
): ClientSubmittalPolicyService {
  const otherwise = opts.otherwise ?? 'UNRESOLVED';
  const unresolved = opts.unresolvedRequisitionIds ?? new Set<string>();
  const dispositionFor = (id: string): 'REQUIRED' | 'NOT_REQUIRED' | 'UNRESOLVED' =>
    requiredRequisitionIds.has(id)
      ? 'REQUIRED'
      : notRequiredRequisitionIds.has(id)
        ? 'NOT_REQUIRED'
        : unresolved.has(id)
          ? 'UNRESOLVED'
          : otherwise;
  const source = { scope: 'TENANT', scope_ref: null, package_name: 'client-submittal-policy', version: 'stub', checksum: 'stub' };
  return {
    resolveEffective: async (_tenant: string, ctx: { requisition_id: string | null }) => {
      const d = dispositionFor(ctx.requisition_id ?? '');
      if (d === 'UNRESOLVED') return null;
      return { requirements: [{ key: 'rtr_present', disposition: d }], layers: [], composite_version: 'stub' };
    },
    resolveRequirementSource: async (_tenant: string, ctx: { requisition_id: string | null }) => {
      const d = dispositionFor(ctx.requisition_id ?? '');
      if (d === 'UNRESOLVED') return { state: 'NO_LAYER' };
      return { state: 'RESOLVED', disposition: d, source, composite_version: 'stub' };
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

// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.8 — the ONE shared helper that gives a
// tenant an explicit RTR requirement through the REAL publish path (TENANT scope by
// default). Specs that exercise Qualified / client submit but are not ABOUT RTR publish
// NOT_REQUIRED so the requirement is RESOLVED (an absent policy is UNRESOLVED and refuses).
export async function publishRtrPolicy(
  policy: ClientSubmittalPolicyService,
  args: {
    tenant_id: string;
    disposition: 'REQUIRED' | 'NOT_REQUIRED';
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
        { key: 'rtr_present', disposition: args.disposition, override_class: 'HARD_DENY', override_policy: 'DEFAULT' },
      ],
    },
    published_by: args.published_by ?? randomUUID(),
  });
}

// Publish an effective policy that makes RTR REQUIRED for the given scope (TENANT by
// default) — the precondition the board / qualification / submittal-readiness / submit
// RTR assertions depend on. Thin wrapper over publishRtrPolicy.
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
  await publishRtrPolicy(policy, { ...args, disposition: 'REQUIRED' });
}

// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.5/§4.8 — the REAL composition-root RTR
// guard over a NOT_REQUIRED policy, for hand-wired `new PipelineRepository(prisma, guard)`
// specs that exercise `qualified` but are not ABOUT RTR. It still runs the real shared
// client-submittal-policy lock + database-clock linearization on the transition tx; the
// executed-RTR query is never issued (NOT_REQUIRED).
export function notRequiredQualifiedGuard(): RtrQualifiedTransitionGuard {
  return new RtrQualifiedTransitionGuard(
    makeDocumentReadinessGate({
      documents: {} as DocumentsRepository,
      policy: rtrPolicyStub(new Set<string>(), new Set<string>(), { otherwise: 'NOT_REQUIRED' }),
    }),
  );
}

// v1.2 §4.1/§4.8 — make a requisition's RTR requirement RESOLVED for specs that submit /
// qualify but are not ABOUT RTR: if the effective `rtr_present` is UNRESOLVED (no layer,
// or layers that never declare it), publish an explicit NOT_REQUIRED at REQUISITION scope
// (it AUGMENTS the key without overriding any other requirement). A requirement the spec
// already set (e.g. publishRtrRequired before seeding) is left untouched.
export async function ensureRtrResolved(
  policy: ClientSubmittalPolicyService,
  args: { tenant_id: string; requisition_id: string; company_id?: string | null },
): Promise<void> {
  const r = await policy.resolveRequirementSource(
    args.tenant_id,
    { company_id: args.company_id ?? null, requisition_id: args.requisition_id },
    'rtr_present',
    new Date(),
  );
  if (r.state === 'RESOLVED') return;
  await publishRtrPolicy(policy, {
    tenant_id: args.tenant_id,
    disposition: 'NOT_REQUIRED',
    scope: 'REQUISITION',
    scope_ref: args.requisition_id,
    version: 'rtr-resolved-1',
  });
}
