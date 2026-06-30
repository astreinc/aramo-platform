import { IsOptional, IsUUID } from 'class-validator';

// LinkTalentRecordRequestDto — the body of POST /v1/talent-records/:id/link.
//
// PR-A5b-2 ASSOCIATE-NOT-RESOLVE boundary: the caller supplies the
// `core_talent_id` explicitly. The linker does NOT search Core by
// email/name/etc. to infer it — the absence of any such resolution
// surface (no `findTalentByEmail`, no `resolveIdentity`) in libs/talent
// and libs/identity is the structural guarantee.
export class LinkTalentRecordRequestDto {
  @IsUUID()
  core_talent_id!: string;

  // 4d (ADR-0016) — the optional PERSON_CLUSTER pointer (identity_index).
  // When supplied, the linker validates the cluster exists and writes
  // TalentRecord.cluster_id. ASSOCIATE-NOT-RESOLVE applies here too: the
  // caller supplies the cluster id; the linker does not infer it.
  @IsOptional()
  @IsUUID()
  cluster_id?: string;
}
