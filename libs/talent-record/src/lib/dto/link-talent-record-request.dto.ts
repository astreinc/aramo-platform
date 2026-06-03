import { IsUUID } from 'class-validator';

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
}
