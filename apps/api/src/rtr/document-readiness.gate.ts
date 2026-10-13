import { Inject, Injectable } from '@nestjs/common';
import { DocumentsRepository } from '@aramo/documents';
import { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';
import { type DocumentEligibilityInput } from '@aramo/submittal-eligibility';

import { RIGHT_TO_REPRESENT_KEY, RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';

// DOC-5 (R-5-7, PL-1) — the document-readiness gate. Resolves the PRE-RESOLVED
// DocumentEligibilityInput for the submit path, mirroring EngagementGateService.
// Readiness is satisfied ONLY by ONE EXECUTED RIGHT_TO_REPRESENT Document jointly
// associated to the EXACT Talent (SUBJECT) AND the EXACT Requisition (REGARDING)
// — the same-document predicate. Opaque refs; the gate holds no ATS truth and
// never mutates Submittal. Lives in apps/api (the only layer that composes the
// scope:boundary Documents finder into the scope:ats submit path).
// Re-exported for existing importers (e.g. the TB-1 board spec); the single
// source is rtr-constants.ts (imported above).
export { RIGHT_TO_REPRESENT_KEY, RIGHT_TO_REPRESENT_TYPE_ID };

export const DOCUMENT_READINESS_DOCS_REPO = 'DOCUMENT_READINESS_DOCS_REPO';

// RTR effective-policy readiness (correctness fix) — the gate resolves a
// requisition's owning company_id so it can read the effective CLIENT-layer
// client-submittal-policy. A STRING-token port (not the bare RequisitionRepository
// class) keeps this self-contained — it avoids importing the heavy RequisitionModule
// into every DocumentReadinessModule consumer AND the bare-class-token non-strict
// lookup collision (same discipline as DOCUMENT_READINESS_DOCS_REPO above).
export const DOCUMENT_READINESS_REQUISITION_COMPANY_ID = 'DOCUMENT_READINESS_REQUISITION_COMPANY_ID';
export interface RequisitionCompanyIdResolver {
  findCompanyId(args: { tenant_id: string; id: string }): Promise<string | null>;
}

// The single client-submittal-policy requirement key that governs RTR applicability.
// RTR is required for a (tenant, company, requisition) ONLY when the effective policy
// declares this key with disposition REQUIRED — the SAME fact key the submit command
// supplies to the policy engine (`facts.rtr_present`).
const RTR_POLICY_REQUIREMENT_KEY = 'rtr_present';

@Injectable()
export class DocumentReadinessGate {
  constructor(
    @Inject(DOCUMENT_READINESS_DOCS_REPO) private readonly documents: DocumentsRepository,
    private readonly clientSubmittalPolicy: ClientSubmittalPolicyService,
    @Inject(DOCUMENT_READINESS_REQUISITION_COMPANY_ID)
    private readonly requisitionCompanyId: RequisitionCompanyIdResolver,
  ) {}

  // The ONE canonical interpretation of the effective RTR requirement, reused by every
  // readiness consumer (Board projection, Qualification transition, Submittal readiness,
  // and the actual submit-to-client validation) so none independently reinterprets a
  // null policy. Applicability is a POLICY fact, never the existence of a
  // DocumentRequirement row. THREE distinct business states (UNGOVERNED ≠ NOT_REQUIRED):
  //   REQUIRED      — effective policy declares `rtr_present` disposition REQUIRED.
  //   NOT_REQUIRED  — effective policy declares `rtr_present` EXPLICITLY NOT_REQUIRED
  //                   (the only state that earns an affirmative "Not required" statement).
  //   UNGOVERNED    — no published client-submittal policy, OR a policy that does not
  //                   mention `rtr_present` at all: the requirement is UNSPECIFIED. This
  //                   is NOT the business claim "not required"; it only means nothing to
  //                   enforce (non-blocking, back-compat), and renders no affirmative label.
  private async resolveRtrDisposition(tenant_id: string, requisition_id: string): Promise<RtrDisposition> {
    const company_id = await this.requisitionCompanyId.findCompanyId({ tenant_id, id: requisition_id });
    const policy = await this.clientSubmittalPolicy.resolveEffective(tenant_id, { company_id, requisition_id });
    if (policy === null) return 'UNGOVERNED';
    const req = policy.requirements.find((r) => r.key === RTR_POLICY_REQUIREMENT_KEY);
    if (req === undefined) return 'UNGOVERNED';
    return req.disposition === 'REQUIRED' ? 'REQUIRED' : 'NOT_REQUIRED';
  }

  // Enforcement axis: a transition/submit is gated ONLY when RTR is explicitly REQUIRED.
  // Both NOT_REQUIRED and UNGOVERNED are non-blocking — the distinction between them is a
  // UI/label concern (see assessManyRtrStatus), not an enforcement one.
  private async isRtrRequired(tenant_id: string, requisition_id: string): Promise<boolean> {
    return (await this.resolveRtrDisposition(tenant_id, requisition_id)) === 'REQUIRED';
  }

  // CONDITIONAL on the effective policy: the gate applies ONLY when policy makes RTR
  // required for this (tenant, requisition). Not required ⇒ ungated (satisfied) — a
  // submit under a tenant/client that does not require RTR is NEVER denied. Required
  // ⇒ require the PL-1 same-document executed RTR for the EXACT (talent, requisition);
  // absent executed doc denies.
  async assess(input: { tenant_id: string; talent_id: string; requisition_id: string }): Promise<DocumentEligibilityInput> {
    if (!(await this.isRtrRequired(input.tenant_id, input.requisition_id))) {
      return { satisfied: true, deny: null }; // RTR not required by policy → ungated
    }
    return this.verifyExecutedRtr(input);
  }

  // INC-1c (TIP-E2E) — the UNCONDITIONAL DOC-5 RTR verdict for the provisional
  // "RTR mandatory before client disclosure" interim product policy. Identical
  // same-document executed-RTR predicate as `assess` (no new validity model is
  // fabricated — the governing authority is the executed RIGHT_TO_REPRESENT
  // Document jointly associated to the EXACT talent + requisition, tenant-scoped;
  // the client/company binding is transitive via the requisition's single owner),
  // but WITHOUT the policy-disposition short-circuit: it fails closed even when the
  // effective client-submittal policy is NOT_REQUIRED or UNGOVERNED. The CONDITIONAL
  // `assess` remains the default; this is invoked only when the interim policy is
  // explicitly activated (Legal/PO gate), so existing valid flows are unchanged.
  async assessMandatory(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
  }): Promise<DocumentEligibilityInput> {
    return this.verifyExecutedRtr(input);
  }

  // The shared PL-1 same-document executed-RTR predicate (tenant-scoped; EXACT
  // talent SUBJECT + requisition REGARDING). A non-null result is the established
  // RTR validity fact (current, executed); absence fails closed. Reused by both the
  // conditional `assess` and the mandatory `assessMandatory` so neither reinterprets
  // RTR validity independently.
  private async verifyExecutedRtr(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
  }): Promise<DocumentEligibilityInput> {
    const executed = await this.documents.findExecutedByTypeAndAssociations({
      tenant_id: input.tenant_id,
      document_type_key: RIGHT_TO_REPRESENT_KEY,
      associations: [
        { resource_type: 'TALENT', resource_id: input.talent_id, relationship: 'SUBJECT' },
        { resource_type: 'REQUISITION', resource_id: input.requisition_id, relationship: 'REGARDING' },
      ],
    });
    if (executed !== null) return { satisfied: true, deny: null };
    return { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED', missing: [RIGHT_TO_REPRESENT_KEY] };
  }

  // Requisition Talent Board (TB-4) — the BATCHED sibling of `assess` for a whole talent set on
  // ONE requisition. Same policy-CONDITIONAL semantic, evaluated with bounded reads (never a
  // per-talent loop — directive §19): ONE effective-policy resolution for the requisition + ONE
  // batched executed-doc query. Reuses this gate's DOC-5 predicate — the Board never re-derives
  // RTR readiness. Returns a per-talent verdict for every input id (ungated → satisfied when
  // policy does not require RTR).
  async assessMany(input: {
    tenant_id: string;
    requisition_id: string;
    talent_ids: readonly string[];
  }): Promise<Map<string, DocumentEligibilityInput>> {
    const out = new Map<string, DocumentEligibilityInput>();
    if (input.talent_ids.length === 0) return out;
    if (!(await this.isRtrRequired(input.tenant_id, input.requisition_id))) {
      // RTR not required by policy for this requisition → every talent is ungated (satisfied).
      for (const t of input.talent_ids) out.set(t, { satisfied: true, deny: null });
      return out;
    }
    const executed = await this.documents.findExecutedSubjectTalentIds({
      tenant_id: input.tenant_id,
      document_type_key: RIGHT_TO_REPRESENT_KEY,
      requisition_id: input.requisition_id,
      talent_ids: input.talent_ids,
    });
    for (const t of input.talent_ids) {
      out.set(
        t,
        executed.has(t)
          ? { satisfied: true, deny: null }
          : { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED', missing: [RIGHT_TO_REPRESENT_KEY] },
      );
    }
    return out;
  }

  // Requisition Talent Board (TB-chips) — the BATCHED RTR board chip per talent for ONE
  // requisition. Policy-CONDITIONAL and three-way, honouring UNGOVERNED ≠ NOT_REQUIRED:
  //   REQUIRED     → the CURRENT document status (same selectCurrent precedence as the
  //                  drawer's rtr-orchestrator.current()) mapped to the signing 3-state so
  //                  the chip matches the drawer:
  //                  EXECUTED → CONFIRMED · PREPARED/EXECUTION_PENDING → SENT · else NOT_SENT.
  //   NOT_REQUIRED → 'NOT_REQUIRED' — the ONLY state that earns the affirmative recruiter
  //                  label "RTR · Not required" (policy explicitly relaxed it).
  //   UNGOVERNED   → null — requirement unspecified; render nothing (neutral/absence), never
  //                  an affirmative "Not required" claim.
  // Bounded reads (one effective-policy resolution + at most one batched status query); never
  // a per-talent loop.
  async assessManyRtrStatus(input: {
    tenant_id: string;
    requisition_id: string;
    talent_ids: readonly string[];
  }): Promise<Map<string, RtrBoardChip>> {
    const out = new Map<string, RtrBoardChip>();
    if (input.talent_ids.length === 0) return out;
    const disposition = await this.resolveRtrDisposition(input.tenant_id, input.requisition_id);
    if (disposition !== 'REQUIRED') {
      // NOT_REQUIRED → affirmative chip; UNGOVERNED → null (no affirmative statement).
      const chip = disposition === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : null;
      for (const t of input.talent_ids) out.set(t, chip);
      return out;
    }
    const statusByTalent = await this.documents.findCurrentDocStatusBySubjectTalentIds({
      tenant_id: input.tenant_id,
      document_type_key: RIGHT_TO_REPRESENT_KEY,
      requisition_id: input.requisition_id,
      talent_ids: input.talent_ids,
    });
    for (const t of input.talent_ids) out.set(t, toRtrChipState(statusByTalent.get(t)));
    return out;
  }
}

// The effective RTR requirement, three-way. UNGOVERNED (unspecified) is deliberately
// distinct from NOT_REQUIRED (explicitly relaxed) — see resolveRtrDisposition.
export type RtrDisposition = 'REQUIRED' | 'NOT_REQUIRED' | 'UNGOVERNED';

// The RTR signing-status 3-state (REQUIRED requisitions only).
export type RtrChipState = 'NOT_SENT' | 'SENT' | 'CONFIRMED';

// The board chip value. 'NOT_REQUIRED' is the affirmative "RTR · Not required" label
// (explicit policy relaxation); null is the UNGOVERNED neutral/absence (render nothing).
export type RtrBoardChip = RtrChipState | 'NOT_REQUIRED' | null;

// Map a current RTR Document.status → the board's 3-state chip. Mirrors the drawer's
// GovernedDocumentSigningService.deriveStatus + the PO ruling: EXECUTED→CONFIRMED,
// PREPARED/EXECUTION_PENDING→SENT; everything else (DRAFT→REQUESTED, VOIDED, or no document
// at all → undefined) is NOT_SENT — the mute "nothing has been sent to the talent yet" state.
function toRtrChipState(docStatus: string | undefined): RtrChipState {
  if (docStatus === 'EXECUTED') return 'CONFIRMED';
  if (docStatus === 'PREPARED' || docStatus === 'EXECUTION_PENDING') return 'SENT';
  return 'NOT_SENT';
}
