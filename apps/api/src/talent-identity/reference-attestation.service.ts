import { Injectable, NotFoundException } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';
import { TalentRecordRepository } from '@aramo/talent-record';
import {
  TalentTrustService,
  STATEMENT_CLASS_DIMENSION,
  type StatementClass,
} from '@aramo/talent-trust';

import type { RecordReferenceAttestationDto } from './dto/reference-attestation.dto.js';

export interface RecordReferenceResult {
  recorded: boolean; // false on an idempotent re-record (same reference twice)
  evidence_id: string;
}

// TR-9 B1 (D5) — the recorded-reference capture service. NO HTTP knowledge; the
// controller supplies (recordId, dto, authContext). Gated like the record it
// belongs to (the record-detail conventions): the record must exist in the
// tenant and be live. Maps the DTO to the ATTESTATION canonical payload and
// delegates the fixed-class/method write + content-hash idempotence to the trust
// service. The platform contacts no one — capture rides the tenant's existing
// basis, exactly as every other evidence producer.
@Injectable()
export class ReferenceAttestationService {
  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly trust: TalentTrustService,
  ) {}

  async recordReference(input: {
    recordId: string;
    dto: RecordReferenceAttestationDto;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<RecordReferenceResult> {
    const tenant_id = input.authContext.tenant_id;

    // Gate 1 — the record exists in THIS tenant (findById is tenant-scoped).
    const record = await this.talentRecords.findById({
      id: input.recordId,
      tenant_id,
    });
    if (record === null) {
      throw new NotFoundException(`Talent record ${input.recordId} not found`);
    }
    // Gate 2 — only a live record accepts new evidence (mirrors the verification
    // surface). A superseded husk is read-only.
    if (record.record_status !== 'live') {
      throw new AramoError(
        'TALENT_RECORD_SUPERSEDED',
        `talent record ${input.recordId} is ${record.record_status}`,
        422,
        { requestId: input.requestId },
      );
    }

    const dto = input.dto;
    const statementClass = dto.statement_class as StatementClass;
    const dimension = STATEMENT_CLASS_DIMENSION[statementClass];

    // Build the raw ATTESTATION payload (the shape normalizes + validates it).
    const attester: Record<string, unknown> = { name_raw: dto.attester.name };
    if (dto.attester.email !== undefined) attester['email_raw'] = dto.attester.email;
    if (dto.attester.company !== undefined) attester['company_raw'] = dto.attester.company;
    if (dto.attester.role !== undefined) attester['role_raw'] = dto.attester.role;

    const assertion_payload: Record<string, unknown> = {
      attester,
      relationship_raw: dto.relationship,
      statement_class: dto.statement_class,
      statement_raw: dto.statement,
      period: {
        start_raw: dto.period?.start,
        end_raw: dto.period?.end,
      },
    };

    const result = await this.trust.recordReferenceAttestationIfAbsent({
      subjectRef: {
        tenant_id,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: input.recordId,
      },
      dimension,
      assertion_payload,
      requestId: input.requestId,
    });

    return { recorded: result.written, evidence_id: result.evidence_id };
  }
}
