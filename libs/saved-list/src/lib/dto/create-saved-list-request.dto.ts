import type { SavedListItemType } from './saved-list-item-type.js';
import type { SavedListVisibility } from './saved-list-visibility.js';

// CreateSavedListRequestDto — POST /v1/saved-lists payload.
//
// item_type is fixed at creation (homogeneity invariant). owner_id is
// derived from AuthContext.sub at the controller layer; not settable
// from the body. tenant_id is never accepted from the body.
//
// CRM-1: visibility is optional and defaults to 'private' (least-visibility,
// directive §5.2/§17). purpose is an optional free-text label.
export interface CreateSavedListRequestDto {
  name: string;
  item_type: SavedListItemType;
  site_id?: string;
  visibility?: SavedListVisibility;
  purpose?: string;
}
