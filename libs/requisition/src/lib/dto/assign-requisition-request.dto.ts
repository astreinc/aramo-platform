// AssignRequisitionRequestDto — POST /v1/requisitions/:id/assignments payload.
// requisition_id resolves from the path param. user_id is the recruiter
// being assigned (not the actor — recruiters do not self-assign per
// directive Ruling 3 / §4; the assign route is tenant_admin-gated).
export interface AssignRequisitionRequestDto {
  user_id: string;
}
