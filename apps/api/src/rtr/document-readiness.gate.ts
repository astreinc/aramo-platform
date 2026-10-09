import { Inject, Injectable } from '@nestjs/common';
import { DocumentsRepository } from '@aramo/documents';
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

@Injectable()
export class DocumentReadinessGate {
  constructor(@Inject(DOCUMENT_READINESS_DOCS_REPO) private readonly documents: DocumentsRepository) {}

  // CONDITIONAL: the gate applies ONLY when an RTR DocumentRequirement exists for
  // this requisition. Absent ⇒ ungated (satisfied) — a submit with no RTR
  // requirement is NEVER denied. Present ⇒ require the PL-1 same-document
  // executed RTR for the EXACT (talent, requisition); absent executed doc denies.
  async assess(input: { tenant_id: string; talent_id: string; requisition_id: string }): Promise<DocumentEligibilityInput> {
    const requirement = await this.documents.findRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
    });
    if (requirement === null) return { satisfied: true, deny: null }; // RTR not required → ungated

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
  // ONE requisition. Same CONDITIONAL semantic, evaluated with bounded reads (never a per-talent
  // loop — directive §19): ONE requirement lookup for the requisition + ONE batched executed-doc
  // query. Reuses this gate's DOC-5 predicate — the Board never re-derives RTR readiness. Returns
  // a per-talent verdict for every input id (ungated → satisfied when no RTR requirement exists).
  async assessMany(input: {
    tenant_id: string;
    requisition_id: string;
    talent_ids: readonly string[];
  }): Promise<Map<string, DocumentEligibilityInput>> {
    const out = new Map<string, DocumentEligibilityInput>();
    if (input.talent_ids.length === 0) return out;
    const requirement = await this.documents.findRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
    });
    if (requirement === null) {
      // RTR not required for this requisition → every talent is ungated (satisfied).
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

  // Requisition Talent Board (TB-chips) — the BATCHED 3-state RTR signing status per talent for
  // ONE requisition (the recruiting-stage board chip). Same CONDITIONAL gate as assessMany: when
  // no RTR DocumentRequirement exists the chip is N/A → the per-talent value is `null` (render
  // nothing). Otherwise the CURRENT document status (same selectCurrent precedence as the drawer's
  // rtr-orchestrator.current()) is mapped to the board's 3-state so the chip matches the drawer:
  //   EXECUTED → CONFIRMED · PREPARED/EXECUTION_PENDING → SENT · DRAFT/absent/other → NOT_SENT.
  // Bounded reads (one requirement lookup + one batched status query); never a per-talent loop.
  async assessManyRtrStatus(input: {
    tenant_id: string;
    requisition_id: string;
    talent_ids: readonly string[];
  }): Promise<Map<string, RtrChipState | null>> {
    const out = new Map<string, RtrChipState | null>();
    if (input.talent_ids.length === 0) return out;
    const requirement = await this.documents.findRequirement({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      resource_type: 'REQUISITION',
      resource_id: input.requisition_id,
    });
    if (requirement === null) {
      // RTR not required for this requisition → no chip (null), never a fabricated state.
      for (const t of input.talent_ids) out.set(t, null);
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

export type RtrChipState = 'NOT_SENT' | 'SENT' | 'CONFIRMED';

// Map a current RTR Document.status → the board's 3-state chip. Mirrors the drawer's
// GovernedDocumentSigningService.deriveStatus + the PO ruling: EXECUTED→CONFIRMED,
// PREPARED/EXECUTION_PENDING→SENT; everything else (DRAFT→REQUESTED, VOIDED, or no document
// at all → undefined) is NOT_SENT — the mute "nothing has been sent to the talent yet" state.
function toRtrChipState(docStatus: string | undefined): RtrChipState {
  if (docStatus === 'EXECUTED') return 'CONFIRMED';
  if (docStatus === 'PREPARED' || docStatus === 'EXECUTION_PENDING') return 'SENT';
  return 'NOT_SENT';
}
