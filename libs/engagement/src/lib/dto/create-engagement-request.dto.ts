import { IsOptional, IsUUID } from 'class-validator';

// M5 PR-4 §4.2 — HTTP request DTO for POST /v1/engagements.
//
// Body shape per directive §4.2:
//   - talent_id: required UUID (Pattern C lookup via TalentRepository
//     .findOverlayByTenant; overlay absence → ENGAGEMENT_REFERENCE_NOT_FOUND).
//   - requisition_id: required UUID (Pattern A lookup via
//     JobDomainRepository.findRequisitionById + tenant cross-check).
//   - examination_id: optional UUID (Pattern B lookup via
//     ExaminationRepository.findById + tenant cross-check; nullable per
//     PR-1 substrate — engagement may exist before examination is
//     computed).
//
// id + event_id are NOT in the request body — generated server-side via
// crypto.randomUUID() in the controller per directive §4.2. tenant_id is
// derived from the JWT AuthContext (NOT in the body).
export class CreateEngagementRequestDto {
  @IsUUID()
  talent_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  examination_id?: string;
}
