import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  EducationEntryRetiredError,
  TalentEducationRepository,
  type EducationEntryFields,
  type EducationEntryWithStateRow,
} from '@aramo/talent-evidence';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TalentTrustService, type EvidenceRecordRow, type SubjectRef } from '@aramo/talent-trust';

import type { TalentEducationEntryRequestDto } from './dto/talent-education.dto.js';
import type { TalentEducationChangeView } from './dto/talent-360.view.js';
import { toEducationRow } from './education-view.js';

// ATS-QA-1 I-4 (L2, amendment A3) — recruiter add / correct / remove of declared
// education. NO HTTP knowledge (the controller supplies the JWT-derived actor).
//
// Authority: talent_evidence.TalentEducationEntry is the ONLY education store.
// Nothing is overwritten or deleted: a correction writes a new `manual` entry and
// retires the old one, a removal retires the entry. Every change writes an audit
// event in the same transaction (TalentEducationRepository).
//
// Visibility: the Talent must exist in the caller's tenant (the same tenant-scoped
// read Talent 360 uses) — another tenant's Talent or entry is a 404, never a 403.
// A superseded record is read-only (422 TALENT_RECORD_SUPERSEDED, the
// reference-attestation precedent).
//
// Ledger (the TR-7 producer contract, extended by A3): each entry has ONE
// canonical CLAIMS/DEGREE claim keyed by source_ref.talent_evidence_id =
// THIRD_PARTY_UNVERIFIED / DOCUMENT, the TR-7 class and method. A manual entry is
// written with ai_derived false, a resume/import entry exactly as the extraction
// producer writes it (ai_derived true). A retired entry's VALID claim is flipped:
// SUPERSEDED by the replacing entry's claim (correction) or REVOKED (removal). The
// sync runs after the entry transaction commits, under a per-Talent lock, and is
// idempotent over ALL of the Talent's entries — so a ledger failure (which
// propagates, the TR-4 B2 loud-fail posture) heals on the next change.

const CREATED_BY = 'talent-education-edit';
const EXTRACTION_CREATED_BY = 'talent-extraction';
const REMOVED_REASON = 'education entry removed by a recruiter';

export interface EducationActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly request_id: string;
}

@Injectable()
export class TalentEducationService {
  private readonly logger = new Logger(TalentEducationService.name);

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly education: TalentEducationRepository,
    private readonly trust: TalentTrustService,
  ) {}

  async add(
    actor: EducationActor,
    talent_id: string,
    body: TalentEducationEntryRequestDto,
  ): Promise<TalentEducationChangeView> {
    await this.requireLiveTalent(actor, talent_id);
    const fields = this.toFields(actor, body);
    const { entry_id } = await this.education.addManual({
      tenant_id: actor.tenant_id,
      talent_id,
      actor_id: actor.user_id,
      fields,
    });
    await this.syncLedger(actor.tenant_id, talent_id);
    return { entry_id, education: await this.current(actor.tenant_id, talent_id) };
  }

  async correct(
    actor: EducationActor,
    talent_id: string,
    entry_id: string,
    body: TalentEducationEntryRequestDto,
  ): Promise<TalentEducationChangeView> {
    await this.requireLiveTalent(actor, talent_id);
    const fields = this.toFields(actor, body);
    const target = await this.requireCurrentEntry(actor, talent_id, entry_id);
    const changed = changedFields(target, fields);
    if (changed.length === 0) {
      // Nothing differs: no new entry, no retirement, no audit event.
      return { entry_id, education: await this.current(actor.tenant_id, talent_id) };
    }
    let written: { entry_id: string } | null;
    try {
      written = await this.education.correct({
        tenant_id: actor.tenant_id,
        talent_id,
        entry_id,
        actor_id: actor.user_id,
        fields,
        changed_fields: changed,
      });
    } catch (err) {
      throw this.mapRetired(err, actor, entry_id);
    }
    if (written === null) throw this.entryNotFound(actor, entry_id);
    await this.syncLedger(actor.tenant_id, talent_id);
    return { entry_id: written.entry_id, education: await this.current(actor.tenant_id, talent_id) };
  }

  async remove(
    actor: EducationActor,
    talent_id: string,
    entry_id: string,
  ): Promise<TalentEducationChangeView> {
    await this.requireLiveTalent(actor, talent_id);
    await this.requireCurrentEntry(actor, talent_id, entry_id);
    let written: { entry_id: string } | null;
    try {
      written = await this.education.remove({
        tenant_id: actor.tenant_id,
        talent_id,
        entry_id,
        actor_id: actor.user_id,
      });
    } catch (err) {
      throw this.mapRetired(err, actor, entry_id);
    }
    if (written === null) throw this.entryNotFound(actor, entry_id);
    await this.syncLedger(actor.tenant_id, talent_id);
    return { entry_id, education: await this.current(actor.tenant_id, talent_id) };
  }

  // ---- gates ----------------------------------------------------------------

  private async requireLiveTalent(actor: EducationActor, talent_id: string): Promise<void> {
    const record = await this.talentRecords.findById({ id: talent_id, tenant_id: actor.tenant_id });
    if (record === null) {
      throw new AramoError('NOT_FOUND', 'Talent not found in tenant', 404, {
        requestId: actor.request_id,
      });
    }
    if (record.record_status !== 'live') {
      throw new AramoError(
        'TALENT_RECORD_SUPERSEDED',
        `talent record ${talent_id} is ${record.record_status}`,
        422,
        { requestId: actor.request_id },
      );
    }
  }

  private async requireCurrentEntry(
    actor: EducationActor,
    talent_id: string,
    entry_id: string,
  ): Promise<EducationEntryWithStateRow> {
    const all = await this.education.listAllForTalent({ tenant_id: actor.tenant_id, talent_id });
    const row = all.find((r) => r.id === entry_id);
    if (row === undefined) throw this.entryNotFound(actor, entry_id);
    if (row.retirement !== null) throw this.retired(actor, entry_id);
    return row;
  }

  private entryNotFound(actor: EducationActor, entry_id: string): AramoError {
    return new AramoError('NOT_FOUND', 'Education entry not found for this Talent', 404, {
      requestId: actor.request_id,
      details: { entry_id },
    });
  }

  private retired(actor: EducationActor, entry_id: string): AramoError {
    return new AramoError(
      'INVALID_REQUEST',
      'This education entry was already corrected or removed. Reload to see the current entries.',
      409,
      { requestId: actor.request_id, details: { entry_id, state: 'retired' } },
    );
  }

  private mapRetired(err: unknown, actor: EducationActor, entry_id: string): unknown {
    return err instanceof EducationEntryRetiredError ? this.retired(actor, entry_id) : err;
  }

  private toFields(actor: EducationActor, body: TalentEducationEntryRequestDto): EducationEntryFields {
    const conferred = body.conferred_date ?? null;
    let conferred_date: Date | null = null;
    if (conferred !== null) {
      conferred_date = new Date(`${conferred}T00:00:00.000Z`);
      // Refuse an impossible calendar date (2023-02-31) instead of rolling it over.
      if (Number.isNaN(conferred_date.getTime()) || conferred_date.toISOString().slice(0, 10) !== conferred) {
        throw new AramoError('VALIDATION_ERROR', 'conferred_date is not a real calendar date', 400, {
          requestId: actor.request_id,
          details: { field: 'conferred_date' },
        });
      }
    }
    return {
      institution_name: body.institution_name,
      degree_name: body.degree_name,
      field_of_study: body.field_of_study ?? null,
      conferred_date,
    };
  }

  private async current(tenant_id: string, talent_id: string) {
    const rows = await this.education.listActiveForTalent({ tenant_id, talent_id });
    return rows.map((r) => {
      const v = toEducationRow(r);
      return { ...v, source_refs: [...v.source_refs] };
    });
  }

  // ---- ledger ---------------------------------------------------------------

  private async syncLedger(tenant_id: string, talent_id: string): Promise<void> {
    await this.education.withLedgerLock({ tenant_id, talent_id }, async () => {
      const entries = await this.education.listAllForTalent({ tenant_id, talent_id });
      if (entries.length === 0) return;
      const subjectRef: SubjectRef = {
        tenant_id,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: talent_id,
        link_source: CREATED_BY,
      };
      const claims = await this.claimsByEntry(subjectRef);

      // 1. Every entry (current or retired) has its claim.
      for (const e of entries) {
        if (claims.has(e.id)) continue;
        const id = await this.writeClaim(subjectRef, e);
        if (id !== null) {
          claims.set(e.id, { id, current_status: 'VALID' } as EvidenceRecordRow);
        }
      }

      // 2. A retired entry's claim leaves the VALID set: superseded by the
      //    replacing entry's claim, or revoked when the entry was removed.
      let flipped = 0;
      for (const e of entries) {
        if (e.retirement === null) continue;
        const claim = claims.get(e.id);
        if (claim === undefined || claim.current_status !== 'VALID') continue;
        const replacing =
          e.retirement.superseded_by_entry_id === null
            ? undefined
            : claims.get(e.retirement.superseded_by_entry_id);
        if (e.retirement.reason === 'corrected' && replacing !== undefined) {
          await this.trust.supersede(tenant_id, claim.id, replacing.id);
        } else {
          await this.trust.revoke(tenant_id, claim.id, REMOVED_REASON);
        }
        flipped += 1;
      }
      if (flipped > 0) {
        this.logger.log({ event: 'talent_education_ledger_synced', tenant_id, talent_id, flipped });
      }
    });
  }

  // The DEGREE claims of the subject, keyed by the entry id they were written
  // for. When an entry somehow has more than one, the VALID one wins.
  private async claimsByEntry(subjectRef: SubjectRef): Promise<Map<string, EvidenceRecordRow>> {
    const out = new Map<string, EvidenceRecordRow>();
    const evidence = await this.trust.getEvidence(subjectRef, { dimension: 'CLAIMS' });
    for (const ev of evidence) {
      if (ev.assertion_type !== 'DEGREE') continue;
      const ref = ev.source_ref as { talent_evidence_id?: unknown } | null;
      const key = ref?.talent_evidence_id;
      if (typeof key !== 'string') continue;
      const prior = out.get(key);
      if (prior === undefined || (prior.current_status !== 'VALID' && ev.current_status === 'VALID')) {
        out.set(key, ev);
      }
    }
    return out;
  }

  private async writeClaim(subjectRef: SubjectRef, e: EducationEntryWithStateRow): Promise<string | null> {
    const claim = degreeClaim(e);
    if (e.source === 'manual') {
      // Recruiter-entered: the same TR-7 class/method, never AI-shaped.
      const ev = await this.trust.recordEvidence({
        subjectRef,
        dimension: 'CLAIMS',
        assertion_type: 'DEGREE',
        assertion_payload: claim.payload,
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: claim.source_ref,
        ai_derived: false,
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: CREATED_BY,
      });
      return ev.id;
    }
    // resume / import: exactly the extraction producer's write (idempotent).
    const r = await this.trust.recordDeclaredClaimIfAbsent({
      subjectRef,
      assertion_type: 'DEGREE',
      assertion_payload: claim.payload,
      source_ref: claim.source_ref,
      created_by: EXTRACTION_CREATED_BY,
    });
    return r.evidence_id ?? null;
  }
}

// The DEGREE claim for one entry — the same payload as the TR-7 extraction mapper
// (talent-extraction mapEducationToClaim, not exported from that lib): required
// institution_raw + degree_raw, optional field_raw and conferred_date_raw.
function degreeClaim(e: {
  id: string;
  institution_name: string;
  degree_name: string;
  field_of_study: string | null;
  conferred_date: Date | null;
}): {
  payload: Record<string, unknown>;
  source_ref: { talent_evidence_id: string; kind: 'education'; store: 'talent_evidence' };
} {
  const payload: Record<string, unknown> = {
    institution_raw: e.institution_name,
    degree_raw: e.degree_name,
  };
  if (e.field_of_study !== null && e.field_of_study.trim() !== '') payload['field_raw'] = e.field_of_study;
  if (e.conferred_date !== null) payload['conferred_date_raw'] = e.conferred_date.toISOString().slice(0, 10);
  return {
    payload,
    source_ref: { talent_evidence_id: e.id, kind: 'education', store: 'talent_evidence' },
  };
}

function changedFields(
  current: { institution_name: string; degree_name: string; field_of_study: string | null; conferred_date: Date | null },
  next: EducationEntryFields,
): string[] {
  const out: string[] = [];
  if (current.institution_name !== next.institution_name) out.push('institution_name');
  if (current.degree_name !== next.degree_name) out.push('degree_name');
  if ((current.field_of_study ?? null) !== next.field_of_study) out.push('field_of_study');
  const a = current.conferred_date?.toISOString().slice(0, 10) ?? null;
  const b = next.conferred_date?.toISOString().slice(0, 10) ?? null;
  if (a !== b) out.push('conferred_date');
  return out;
}
