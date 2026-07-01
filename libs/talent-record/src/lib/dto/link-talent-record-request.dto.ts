import { IsUUID } from 'class-validator';

// LinkTalentRecordRequestDto — the body of POST /v1/talent-records/:id/link.
//
// ASSOCIATE-NOT-RESOLVE boundary: the caller supplies the `cluster_id`
// explicitly. The linker does NOT search identity_index by email/name/etc.
// to infer it — the absence of any such resolution surface (no
// `findClusterByFingerprint` reached from here, no `resolveIdentity`) in the
// link path is the structural guarantee.
//
// 4e-rest: the Core-Talent link (core_talent_id) was dropped; cluster_id (the
// PERSON_CLUSTER pointer in identity_index) is now the REQUIRED link input.
// This is operation INPUT, inside the trust wall — allowed to name the
// cross-tenant id (unlike the tenant-visible read surfaces, which never do).
export class LinkTalentRecordRequestDto {
  @IsUUID()
  cluster_id!: string;
}
