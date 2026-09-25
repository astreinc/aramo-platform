import { Inject, Injectable } from '@nestjs/common';
import { DocumentsRepository } from '@aramo/documents';
import { type DocumentEligibilityInput } from '@aramo/submittal-eligibility';

// DOC-5 (R-5-7, PL-1) — the document-readiness gate. Resolves the PRE-RESOLVED
// DocumentEligibilityInput for the submit path, mirroring EngagementGateService.
// Readiness is satisfied ONLY by ONE EXECUTED RIGHT_TO_REPRESENT Document jointly
// associated to the EXACT Talent (SUBJECT) AND the EXACT Requisition (REGARDING)
// — the same-document predicate. Opaque refs; the gate holds no ATS truth and
// never mutates Submittal. Lives in apps/api (the only layer that composes the
// scope:boundary Documents finder into the scope:ats submit path).
export const RIGHT_TO_REPRESENT_KEY = 'RIGHT_TO_REPRESENT';
// The seeded SYSTEM RIGHT_TO_REPRESENT DocumentType id (R-5-2, fixed UUID).
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

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
}
