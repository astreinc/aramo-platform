import { Global, Injectable, Module } from '@nestjs/common';
import {
  EVIDENCE_REFERENCE_VERIFIER,
  type EvidenceReferenceInput,
  type EvidenceReferenceVerifierPort,
  type EvidenceVerification,
  type EvidenceVerifierTx,
} from '@aramo/pipeline';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2(a)/(b) (S4, A1 AM-4) — the
// composition-root adapter for the Pipeline EVIDENCE_REFERENCE_VERIFIER port. It is the ONLY
// place an evidence-backed milestone (contacted / talent_responded) is joined to the
// Communications record it rests on (ADR-0029 wall: libs/pipeline depends solely on the port;
// no Pipeline→Communications nx edge — this reads the communications schema by raw SQL on the
// Pipeline transition's OWN transaction, the same-DB cross-schema precedent).
//
//   communication_interaction / recruiter_response_confirmation — the interaction must exist
//     in the tenant, carry a talent_record/subject association to THIS Talent and a
//     requisition/regarding association to THIS requisition. Locked FOR SHARE so the verified
//     row is the one the committed milestone rests on. A recruiter_response_confirmation must
//     additionally BE one: recruiter-attested, latest disposition response_confirmed.
//   provider_observation — there is NO durable, tenant-scoped, verified receipt store yet
//     (§7.2(b)), so every provider observation is refused EVIDENCE_NOT_DURABLE; the Pipeline
//     never advances speculatively. Becomes verifiable when such a receipt store exists.
@Injectable()
export class CommunicationsEvidenceReferenceVerifier implements EvidenceReferenceVerifierPort {
  async verifyInTx(tx: EvidenceVerifierTx, input: EvidenceReferenceInput): Promise<EvidenceVerification> {
    if (input.kind === 'provider_observation') {
      return { verified: false, reason: 'EVIDENCE_NOT_DURABLE' };
    }
    if (input.kind !== 'communication_interaction' && input.kind !== 'recruiter_response_confirmation') {
      return { verified: false, reason: 'kind_not_supported' };
    }
    if (!UUID_RE.test(input.id)) return { verified: false, reason: 'reference_not_found' };
    const rows = await tx.$queryRawUnsafe<
      Array<{ evidence_authority: string; talent_ok: boolean; requisition_ok: boolean; disposition: string | null }>
    >(
      `SELECT i."evidence_authority"::text AS evidence_authority,
              EXISTS (SELECT 1 FROM "communications"."CommunicationAssociation" a
                       WHERE a."tenant_id" = i."tenant_id" AND a."interaction_id" = i."id"
                         AND a."subject_type" = 'talent_record' AND a."relation_type" = 'subject'
                         AND a."subject_id" = $3::uuid) AS talent_ok,
              EXISTS (SELECT 1 FROM "communications"."CommunicationAssociation" a
                       WHERE a."tenant_id" = i."tenant_id" AND a."interaction_id" = i."id"
                         AND a."subject_type" = 'requisition' AND a."relation_type" = 'regarding'
                         AND a."subject_id" = $4::uuid) AS requisition_ok,
              (SELECT d."disposition"::text FROM "communications"."CommunicationDisposition" d
                WHERE d."tenant_id" = i."tenant_id" AND d."interaction_id" = i."id"
                ORDER BY d."dispositioned_at" DESC, d."id" DESC LIMIT 1) AS disposition
         FROM "communications"."CommunicationInteraction" i
        WHERE i."tenant_id" = $1::uuid AND i."id" = $2::uuid
        FOR SHARE OF i`,
      input.tenant_id,
      input.id,
      input.talent_id,
      input.requisition_id,
    );
    const row = rows[0];
    if (row === undefined) return { verified: false, reason: 'reference_not_found' };
    if (!row.talent_ok) return { verified: false, reason: 'talent_mismatch' };
    if (!row.requisition_ok) return { verified: false, reason: 'requisition_mismatch' };
    if (
      input.kind === 'recruiter_response_confirmation' &&
      (row.evidence_authority !== 'recruiter_attested' || row.disposition !== 'response_confirmed')
    ) {
      return { verified: false, reason: 'not_a_response_confirmation' };
    }
    return { verified: true };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// @Global so the PipelineRepository (in its own module) can inject the STRING token.
@Global()
@Module({
  providers: [
    CommunicationsEvidenceReferenceVerifier,
    { provide: EVIDENCE_REFERENCE_VERIFIER, useExisting: CommunicationsEvidenceReferenceVerifier },
  ],
  exports: [EVIDENCE_REFERENCE_VERIFIER, CommunicationsEvidenceReferenceVerifier],
})
export class EvidenceReferenceVerifierModule {}
