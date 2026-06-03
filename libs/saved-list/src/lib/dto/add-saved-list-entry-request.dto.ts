import type { SavedListItemType } from './saved-list-item-type.js';

// AddSavedListEntryRequestDto — POST /v1/saved-lists/:list_id/entries.
//
// item_type MUST match the parent SavedList.item_type (homogeneity
// invariant — service-layer check; mismatch → 422
// SAVED_LIST_ITEM_TYPE_MISMATCH).
//
// item_id is the typed entity UUID. The service validates existence in
// the actor's tenant via the matching repository's findById (the A4
// shape). Bad item_id → 404 NOT_FOUND.
export interface AddSavedListEntryRequestDto {
  item_type: SavedListItemType;
  item_id: string;
}
