import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  TalentExtractionService,
  type TalentResumeEditionRow,
} from '@aramo/talent-extraction';

// TALENT-INTEL-1 TI-1D-C §A/§B — the shared résumé-edition ingestion composition.
// Both callers (confirmed-CREATE-from-résumé and existing-Talent new-résumé
// upload) mint a TalentDocument and then run THIS to create exactly one companion
// TalentResumeEdition. It owns the edition-creation POLICY:
//   - idempotent on talent_document_id (a retry never creates a second edition),
//   - establish the TalentResumeDefault ONLY for the Talent's FIRST edition,
//   - NEVER change the default for later editions (no latest==default==truth),
//   - never delete/retract a prior edition or its evidence.
// It does NOT extract or mint the document (the callers do that upstream, each via
// the ONE shared ResumeExtractionOrchestrator pipeline / the confirmed-create doc
// mint) — so no second extraction/model call happens here.

export type ResumeEditionPurpose =
  | 'GENERAL'
  | 'ROLE_FAMILY'
  | 'REQUISITION'
  | 'CLIENT_SUBMITTAL'
  | 'USER_DEFINED';

export interface CreateEditionForDocumentInput {
  tenant_id: string;
  talent_id: string;
  talent_document_id: string;
  // The deterministic extracted-text/source-map SHA-256 (ruling C — reuse the
  // existing resume_text_hash; do NOT re-hash bytes here).
  content_hash: string;
  created_by: string;
  attachment_id?: string;
  purpose?: ResumeEditionPurpose;
  label?: string;
  requisition_id?: string;
  client_context_id?: string;
  derived_from_edition_id?: string;
}

export interface CreateEditionForDocumentResult {
  edition: TalentResumeEditionRow;
  is_default: boolean;
  created: boolean;
}

@Injectable()
export class ResumeEditionIngestionService {
  constructor(private readonly talentExtraction: TalentExtractionService) {}

  async createEditionForDocument(
    input: CreateEditionForDocumentInput,
  ): Promise<CreateEditionForDocumentResult> {
    // Idempotency (ruling B): at most one edition per TalentDocument. A retry for
    // the same document returns the existing edition, creating nothing.
    const existing = await this.talentExtraction.findResumeEditionByDocument(
      input.talent_document_id,
    );
    if (existing !== null) {
      return this.withDefaultFlag(existing, false);
    }

    let edition: TalentResumeEditionRow;
    try {
      edition = await this.talentExtraction.createResumeEdition({
        id: uuidv7(),
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        talent_document_id: input.talent_document_id,
        content_hash: input.content_hash,
        created_at: new Date(),
        created_by: input.created_by,
        attachment_id: input.attachment_id,
        purpose: input.purpose,
        label: input.label,
        requisition_id: input.requisition_id,
        client_context_id: input.client_context_id,
        derived_from_edition_id: input.derived_from_edition_id,
      });
    } catch (err) {
      // Lost a create race on the unique talent_document_id → treat as idempotent.
      const raced = await this.talentExtraction.findResumeEditionByDocument(
        input.talent_document_id,
      );
      if (raced !== null) return this.withDefaultFlag(raced, false);
      throw err;
    }

    // Establish the default ONLY when the Talent has none (its FIRST edition).
    // Later editions never move it — changing the default is an explicit user act.
    const def = await this.talentExtraction.getDefaultResumeEdition({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
    });
    if (def === null) {
      await this.talentExtraction.setDefaultResumeEdition({
        id: uuidv7(),
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        resume_edition_id: edition.id,
        set_at: new Date(),
        set_by: input.created_by,
      });
      return { edition, is_default: true, created: true };
    }
    return { edition, is_default: def.resume_edition_id === edition.id, created: true };
  }

  private async withDefaultFlag(
    edition: TalentResumeEditionRow,
    created: boolean,
  ): Promise<CreateEditionForDocumentResult> {
    const def = await this.talentExtraction.getDefaultResumeEdition({
      tenant_id: edition.tenant_id,
      talent_id: edition.talent_id,
    });
    return { edition, is_default: def?.resume_edition_id === edition.id, created };
  }
}
