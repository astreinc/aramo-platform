// SavedListVisibility — closed list mirroring the Prisma enum (CRM-1).
//
// V1 supports exactly two postures (directive §5.2):
//   - 'private': readable/mutable only by the creator plus admin-tier authority.
//   - 'tenant':  readable by any authorized actor in the tenant; mutable only by
//     the creator plus admin-tier (PO ruling — shared lists are collaborative to
//     READ, curated by their creator).
// Team / dynamic / saved-query visibility are explicitly NOT V1.
export const SAVED_LIST_VISIBILITY_VALUES = ['private', 'tenant'] as const;

export type SavedListVisibility = (typeof SAVED_LIST_VISIBILITY_VALUES)[number];

export const SAVED_LIST_DEFAULT_VISIBILITY: SavedListVisibility = 'private';

export function isSavedListVisibility(v: unknown): v is SavedListVisibility {
  return (
    typeof v === 'string' &&
    (SAVED_LIST_VISIBILITY_VALUES as readonly string[]).includes(v)
  );
}
