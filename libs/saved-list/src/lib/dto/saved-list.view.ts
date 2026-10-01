import type { SavedListItemType } from './saved-list-item-type.js';
import type { SavedListVisibility } from './saved-list-visibility.js';

export interface SavedListView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_id: string;
  name: string;
  item_type: SavedListItemType;
  // CRM-1 — visibility posture + optional free-text label (additive).
  visibility: SavedListVisibility;
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedListEntryView {
  id: string;
  tenant_id: string;
  saved_list_id: string;
  item_type: SavedListItemType;
  item_id: string;
  created_at: string;
}

export interface SavedListWithEntriesView extends SavedListView {
  entries: SavedListEntryView[];
}
