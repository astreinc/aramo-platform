import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  EducationEntryRetiredError,
  TalentEducationRepository,
  type EducationEntryFields,
  type EducationEntryWithStateRow,
} from '@aramo/talent-evidence';
import { TalentRecordRepository } from '@aramo/talent-record';

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
// ATI-SEP-1 T10 WP1 — the trust-ledger DEGREE-claim sync was removed (write-side
// legacy feeds off). Education reaches Talent Intelligence through the
// talent.profile_updated event recorded after every committed change.

export interface EducationActor {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly request_id: string;
}

@Injectable()
export class TalentEducationService {
  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly education: TalentEducationRepository,
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
    await this.recordChanged(actor, talent_id);
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
    await this.recordChanged(actor, talent_id);
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
    await this.recordChanged(actor, talent_id);
    return { entry_id, education: await this.current(actor.tenant_id, talent_id) };
  }

  // ATI-SEP-1 A3 — the committed education change is an ATS evidence edit:
  // record talent.profile_updated (field names only) right after the entry
  // transaction.
  private async recordChanged(actor: EducationActor, talent_id: string): Promise<void> {
    await this.talentRecords.recordProfileUpdated({
      tenant_id: actor.tenant_id,
      talent_record_id: talent_id,
      changed_fields: ['education'],
      correlation_id: actor.request_id,
    });
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
