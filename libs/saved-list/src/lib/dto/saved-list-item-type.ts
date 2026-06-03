// SavedListItemType — closed list mirroring the Prisma enum.
//
// Vocabulary discipline (R12, Tier-2): the 4 values use the Aramo
// canonical terms (talent_record / company / contact / requisition),
// not the legacy OpenCATS labels.
export const SAVED_LIST_ITEM_TYPE_VALUES = [
  'talent_record',
  'company',
  'contact',
  'requisition',
] as const;

export type SavedListItemType = (typeof SAVED_LIST_ITEM_TYPE_VALUES)[number];

export function isSavedListItemType(v: unknown): v is SavedListItemType {
  return (
    typeof v === 'string' &&
    (SAVED_LIST_ITEM_TYPE_VALUES as readonly string[]).includes(v)
  );
}
