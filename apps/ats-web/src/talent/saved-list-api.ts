import { apiClient } from '@aramo/fe-foundation';

// CRM-2 — Talent-page saved-list client. Backs the bulk "Add to list" modal.
// Lists are talent_record-typed here; visibility is PRIVATE (default) or TENANT
// (backend-enforced — CRM-1). The full Lists index/detail UI is CRM-3.

export type SavedListVisibility = 'private' | 'tenant';

export interface SavedListView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly owner_id: string;
  readonly name: string;
  readonly item_type: 'talent_record' | 'company' | 'contact' | 'requisition';
  readonly visibility: SavedListVisibility;
  readonly purpose: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SavedListEntryView {
  readonly id: string;
  readonly tenant_id: string;
  readonly saved_list_id: string;
  readonly item_type: string;
  readonly item_id: string;
  readonly created_at: string;
}

// Lists the tenant's talent-typed saved lists the actor can see (visibility
// enforced server-side). Filtered to item_type=talent_record for the modal.
export async function listTalentSavedLists(): Promise<SavedListView[]> {
  const res = await apiClient.get<{ items: SavedListView[] }>(
    `/v1/saved-lists`,
  );
  return res.items.filter((l) => l.item_type === 'talent_record');
}

export async function createTalentSavedList(body: {
  name: string;
  visibility: SavedListVisibility;
  purpose?: string;
}): Promise<SavedListView> {
  return apiClient.post<SavedListView>(`/v1/saved-lists`, {
    name: body.name,
    item_type: 'talent_record',
    visibility: body.visibility,
    ...(body.purpose === undefined || body.purpose.trim() === ''
      ? {}
      : { purpose: body.purpose.trim() }),
  });
}

// Add one talent to a list. The backend @@unique makes a re-add a 409/no-op;
// the caller treats "already a member" as success (skip-existing semantics).
export async function addTalentToSavedList(
  listId: string,
  talentRecordId: string,
): Promise<void> {
  await apiClient.post<SavedListEntryView>(
    `/v1/saved-lists/${encodeURIComponent(listId)}/entries`,
    { item_type: 'talent_record', item_id: talentRecordId },
  );
}
