// NoteVisibility — RN-1 (LOCKED) mirror of the Prisma `activity.NoteVisibility`
// enum. Persisted authorial-intent confidentiality (first-class, not
// read-time-only). RN-1 ships exactly TEAM + PRIVATE (Q1). PRIVATE is strictly
// author-only — no admin/support override (Q3). RESTRICTED is DEFERRED to RN-2
// and is intentionally NOT a value here. Default TEAM.
export const NOTE_VISIBILITY_VALUES = ['TEAM', 'PRIVATE'] as const;

export type NoteVisibility = (typeof NOTE_VISIBILITY_VALUES)[number];

export const DEFAULT_NOTE_VISIBILITY: NoteVisibility = 'TEAM';

export function isNoteVisibility(value: unknown): value is NoteVisibility {
  return (
    typeof value === 'string' &&
    (NOTE_VISIBILITY_VALUES as readonly string[]).includes(value)
  );
}
