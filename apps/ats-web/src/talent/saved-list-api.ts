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

// CRM-3 — index row carries the backend entry count ("People").
export interface SavedListRowView extends SavedListView {
  readonly member_count?: number;
}

export interface SavedListWithEntriesView extends SavedListRowView {
  readonly entries: readonly SavedListEntryView[];
}

// CRM-3 — reverse membership (Talent-page "Lists" column + modal "already in").
export interface SavedListMembershipView {
  readonly item_id: string;
  readonly lists: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly visibility: SavedListVisibility;
  }>;
}

// Lists the tenant's talent-typed saved lists the actor can see (visibility
// enforced server-side). Filtered to item_type=talent_record for the modal/index.
export async function listTalentSavedLists(): Promise<SavedListRowView[]> {
  const res = await apiClient.get<{ items: SavedListRowView[] }>(
    `/v1/saved-lists`,
  );
  return res.items.filter((l) => l.item_type === 'talent_record');
}

// CRM-3 — a single list + its entries (Lists detail header + entry id-set).
export async function getSavedList(id: string): Promise<SavedListWithEntriesView> {
  return apiClient.get<SavedListWithEntriesView>(
    `/v1/saved-lists/${encodeURIComponent(id)}`,
  );
}

// CRM-3 — reverse membership for a set of talent ids (visibility-scoped server-
// side; another actor's PRIVATE list never leaves the DB). One batch call.
export async function listTalentMemberships(
  talentIds: readonly string[],
): Promise<SavedListMembershipView[]> {
  if (talentIds.length === 0) return [];
  const params = new URLSearchParams({
    item_type: 'talent_record',
    item_ids: talentIds.join(','),
  });
  const res = await apiClient.get<{ items: SavedListMembershipView[] }>(
    `/v1/saved-lists/memberships?${params.toString()}`,
  );
  return res.items;
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

// Add one talent to a list. CRM-3 — the backend add is IDEMPOTENT (a re-add is a
// benign no-op returning the existing entry), so a duplicate is never an error.
export async function addTalentToSavedList(
  listId: string,
  talentRecordId: string,
): Promise<void> {
  await apiClient.post<SavedListEntryView>(
    `/v1/saved-lists/${encodeURIComponent(listId)}/entries`,
    { item_type: 'talent_record', item_id: talentRecordId },
  );
}

// CRM-3 — remove a membership entry (Lists detail "Remove"). Removes ONLY the
// SavedListEntry; never deletes the Talent.
export async function removeSavedListEntry(
  listId: string,
  entryId: string,
): Promise<void> {
  await apiClient.delete<void>(
    `/v1/saved-lists/${encodeURIComponent(listId)}/entries/${encodeURIComponent(entryId)}`,
  );
}
