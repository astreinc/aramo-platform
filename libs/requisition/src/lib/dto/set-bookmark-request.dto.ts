// SetBookmarkRequestDto — PUT /v1/requisitions/:id/bookmark payload.
//
// PR-14 (Track C). Idempotent SET semantics (not a blind flip): the body
// carries the DESIRED bookmark state, so repeated PUTs converge — bookmark
// -twice stays bookmarked, un-bookmark-twice stays un-bookmarked. This is the
// only reading under which the directive's "toggle is idempotent" test holds;
// a flip toggle would not be idempotent. Validated manually at the controller
// boundary (typeof === 'boolean'), mirroring the other requisition request
// DTOs — an `interface` imported as `type` carries no class-validator metadata.
export interface SetBookmarkRequestDto {
  bookmarked: boolean;
}
