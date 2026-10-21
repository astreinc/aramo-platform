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
  // missing policy. Applicability is a POLICY fact, never the existence of a
  // DocumentRequirement row. THREE business states — Talent Lifecycle R1–R5 Impl
  // Directive v1.2 §4.1 (A1 AM-6 §7.3; the former UNGOVERNED is SUPERSEDED):
  //   REQUIRED      — effective policy declares `rtr_present` disposition REQUIRED.
  //   NOT_REQUIRED  — effective policy declares `rtr_present` EXPLICITLY NOT_REQUIRED.
  //   UNRESOLVED    — (a) no active client-submittal policy layer at all, OR (b) a policy
  //                   whose layers never declare `rtr_present`. NEVER treated as
  //                   "not required": it refuses Qualified AND new client submittal.
  // Resolved through the governed TENANT -> CLIENT -> REQUISITION merge (FLOOR
  // fail-closed) at `at` — the caller's linearization instant on the enforcing paths
  // (v1.2 §4.4(d)); "now" on the read-only projections.
  async resolveRtrPolicy(tenant_id: string, requisition_id: string, at: Date = new Date()): Promise<RtrPolicyDecision> {
    const company_id = await this.requisitionCompanyId.findCompanyId({ tenant_id, id: requisition_id });
    const r = await this.clientSubmittalPolicy.resolveRequirementSource(
      tenant_id,
      { company_id, requisition_id },
      RTR_POLICY_REQUIREMENT_KEY,
      at,
    );
    const resolved_at = at.toISOString();
    if (r.state === 'NO_LAYER') {
      return { disposition: 'UNRESOLVED', unresolved_reason: 'NO_LAYER', source: null, scope_ref: null, version: null, checksum: null, composite_version: null, resolved_at };
    }
    if (r.state === 'NO_KEY') {
      return { disposition: 'UNRESOLVED', unresolved_reason: 'NO_KEY', source: null, scope_ref: null, version: null, checksum: null, composite_version: r.composite_version, resolved_at };
    }
    return {
      disposition: r.disposition === 'REQUIRED' ? 'REQUIRED' : 'NOT_REQUIRED',
      source: RTR_POLICY_SOURCE[r.source.scope],
      scope_ref: r.source.scope_ref,
      version: r.source.version,
      checksum: r.source.checksum,
      composite_version: r.composite_version,
      resolved_at,
    };
  }

  private async resolveRtrDisposition(tenant_id: string, requisition_id: string): Promise<RtrDisposition> {
    return (await this.resolveRtrPolicy(tenant_id, requisition_id)).disposition;
  }

  // CONDITIONAL on the effective policy: the gate applies ONLY when policy makes RTR
  // required for this (tenant, requisition). Not required ⇒ ungated (satisfied) — a
  // submit under a tenant/client that does not require RTR is NEVER denied. Required
  // ⇒ require the PL-1 same-document executed RTR for the EXACT (talent, requisition);
  // absent executed doc denies.
  async assess(input: { tenant_id: string; talent_id: string; requisition_id: string }): Promise<DocumentEligibilityInput> {
    const disposition = await this.resolveRtrDisposition(input.tenant_id, input.requisition_id);
    if (disposition === 'UNRESOLVED') return UNRESOLVED_VERDICT; // v1.2 §4.1 — never "not required"
    if (disposition === 'NOT_REQUIRED') return { satisfied: true, deny: null }; // explicitly relaxed
    return this.verifyExecutedRtr(input);
  }

  // Talent Lifecycle R1–R5 Impl Directive v1.2 §4.3/§4.6 — the ENFORCING, IN-TRANSACTION
  // verdict for the Qualified transition and client submit. Runs on the CALLER'S
  // transaction (`tx`), after the caller holds the SHARED client-submittal-policy lock and
  // read its linearization instant `at` (§4.4(d)). When RTR is REQUIRED the executed RTR is
  // located with `FOR SHARE OF d` on that same transaction, so any invalidating UPDATE of
  // the Document row (and erasure's FOR UPDATE) blocks until the caller commits; under READ
  // COMMITTED a void committed first is re-checked against `status = 'EXECUTED'` and the row
  // drops out (refusal). Returns the verdict AND the policy decision for the audit record.
  async assessInTx(
    tx: RtrLockCapableTx,
    input: { tenant_id: string; talent_id: string; requisition_id: string; at: Date },
  ): Promise<{ verdict: DocumentEligibilityInput; policy: RtrPolicyDecision }> {
    const policy = await this.resolveRtrPolicy(input.tenant_id, input.requisition_id, input.at);
    if (policy.disposition === 'UNRESOLVED') return { verdict: UNRESOLVED_VERDICT, policy };
    if (policy.disposition === 'NOT_REQUIRED') return { verdict: { satisfied: true, deny: null }, policy };
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT d."id"
         FROM "documents"."Document" d
         JOIN "documents"."DocumentType" t ON t."id" = d."document_type_id"
        WHERE d."tenant_id" = $1::uuid
          AND d."status" = 'EXECUTED'
          AND t."key" = $2
          AND EXISTS (SELECT 1 FROM "documents"."DocumentAssociation" a
                       WHERE a."document_id" = d."id" AND a."tenant_id" = d."tenant_id"
                         AND a."resource_type" = 'TALENT' AND a."resource_id" = $3::uuid AND a."relationship" = 'SUBJECT')
          AND EXISTS (SELECT 1 FROM "documents"."DocumentAssociation" a
                       WHERE a."document_id" = d."id" AND a."tenant_id" = d."tenant_id"
                         AND a."resource_type" = 'REQUISITION' AND a."resource_id" = $4::uuid AND a."relationship" = 'REGARDING')
        ORDER BY d."id"
        LIMIT 1
        FOR SHARE OF d`,
      input.tenant_id,
      RIGHT_TO_REPRESENT_KEY,
      input.talent_id,
      input.requisition_id,
    );
    if (rows.length > 0) return { verdict: { satisfied: true, deny: null }, policy };
    return {
      verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED', missing: [RIGHT_TO_REPRESENT_KEY] },
      policy,
    };
  }

  // INC-1c (TIP-E2E) — the UNCONDITIONAL DOC-5 RTR verdict for the provisional
  // "RTR mandatory before client disclosure" interim product policy. Identical
  // same-document executed-RTR predicate as `assess` (no new validity model is
  // fabricated — the governing authority is the executed RIGHT_TO_REPRESENT
  // Document jointly associated to the EXACT talent + requisition, tenant-scoped;
  // the client/company binding is transitive via the requisition's single owner),
  // but WITHOUT the policy-disposition short-circuit: it fails closed even when the
  // effective client-submittal policy is NOT_REQUIRED or UNRESOLVED. The CONDITIONAL
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
    const disposition = await this.resolveRtrDisposition(input.tenant_id, input.requisition_id);
    if (disposition !== 'REQUIRED') {
      // NOT_REQUIRED → every talent ungated (satisfied). UNRESOLVED (v1.2 §4.1) → every
      // talent refused — the Board withholds Qualify exactly like the write path.
      const verdict = disposition === 'UNRESOLVED' ? UNRESOLVED_VERDICT : { satisfied: true, deny: null };
      for (const t of input.talent_ids) out.set(t, verdict);
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
  // requisition. Policy-CONDITIONAL and three-way, honouring UNRESOLVED ≠ NOT_REQUIRED:
  //   REQUIRED     → the CURRENT document status (same selectCurrent precedence as the
  //                  drawer's rtr-orchestrator.current()) mapped to the signing 3-state so
  //                  the chip matches the drawer:
  //                  EXECUTED → CONFIRMED · PREPARED/EXECUTION_PENDING → SENT · else NOT_SENT.
  //   NOT_REQUIRED → 'NOT_REQUIRED' — the ONLY state that earns the affirmative recruiter
  //                  label "RTR · Not required" (policy explicitly relaxed it).
  //   UNRESOLVED   → 'POLICY_UNRESOLVED' — v1.2 §4.7: the requirement is not configured;
  //                  an ACTIONABLE state (Qualify withheld), never the neutral "no chip".
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
      // NOT_REQUIRED → affirmative chip; UNRESOLVED → the actionable policy-unresolved chip.
      const chip: RtrBoardChip = disposition === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'POLICY_UNRESOLVED';
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

// The effective RTR requirement, three-way (v1.2 §4.1). UNRESOLVED (not configured) is
// deliberately distinct from NOT_REQUIRED (explicitly relaxed) and is NEVER satisfied.
export type RtrDisposition = 'REQUIRED' | 'NOT_REQUIRED' | 'UNRESOLVED';

// v1.2 §4.2 audit vocabulary — the layer that set the effective `rtr_present`.
export type RtrPolicySource = 'TENANT_DEFAULT' | 'CLIENT_OVERRIDE' | 'REQUISITION_OVERRIDE';
const RTR_POLICY_SOURCE: Record<'TENANT' | 'CLIENT' | 'REQUISITION', RtrPolicySource> = {
  TENANT: 'TENANT_DEFAULT',
  CLIENT: 'CLIENT_OVERRIDE',
  REQUISITION: 'REQUISITION_OVERRIDE',
};

// The resolved RTR policy decision recorded on every Qualified transition and RTR-gated
// client submit (v1.2 §4.6): disposition + source layer + version + checksum + t_L.
export interface RtrPolicyDecision {
  readonly disposition: RtrDisposition;
  readonly unresolved_reason?: 'NO_LAYER' | 'NO_KEY';
  readonly source: RtrPolicySource | null;
  readonly scope_ref: string | null;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly composite_version: string | null;
  readonly resolved_at: string;
}

// The minimal raw-query surface of a caller's interactive transaction (v1.2 T-1).
export interface RtrLockCapableTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const UNRESOLVED_VERDICT: DocumentEligibilityInput = {
  satisfied: false,
  deny: 'SUBMITTAL_RTR_POLICY_UNRESOLVED',
  missing: ['rtr_policy'],
};

// The RTR signing-status 3-state (REQUIRED requisitions only).
// Pipeline & RTR Recon Remediation Directive v1.0 R2 (DEF-12) — DECLINED / EXPIRED: the signing
// ended without execution (a new RTR is needed); never shown as SENT ("Awaiting signature").
export type RtrChipState = 'NOT_SENT' | 'SENT' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED';

// The board chip value. 'NOT_REQUIRED' is the affirmative "RTR · Not required" label
// (explicit policy relaxation); 'POLICY_UNRESOLVED' is the actionable not-configured state.
export type RtrBoardChip = RtrChipState | 'NOT_REQUIRED' | 'POLICY_UNRESOLVED';

// Map a current RTR Document.status → the board's 3-state chip. Mirrors the drawer's
// GovernedDocumentSigningService.deriveStatus + the PO ruling: EXECUTED→CONFIRMED,
// PREPARED/EXECUTION_PENDING→SENT; everything else (DRAFT→REQUESTED, VOIDED, or no document
// at all → undefined) is NOT_SENT — the mute "nothing has been sent to the talent yet" state.
function toRtrChipState(docStatus: string | undefined): RtrChipState {
  if (docStatus === 'EXECUTED') return 'CONFIRMED';
  if (docStatus === 'PREPARED' || docStatus === 'EXECUTION_PENDING') return 'SENT';
  // R2 (DEF-12) — the Talent declined, or the signing window passed.
  if (docStatus === 'DECLINED') return 'DECLINED';
  if (docStatus === 'EXPIRED') return 'EXPIRED';
  return 'NOT_SENT';
}
