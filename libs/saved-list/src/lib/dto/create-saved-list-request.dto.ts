import type { SavedListItemType } from './saved-list-item-type.js';

// CreateSavedListRequestDto — POST /v1/saved-lists payload.
//
// item_type is fixed at creation (homogeneity invariant). owner_id is
// derived from AuthContext.sub at the controller layer; not settable
// from the body. tenant_id is never accepted from the body.
export interface CreateSavedListRequestDto {
  name: string;
  item_type: SavedListItemType;
  site_id?: string;
}
