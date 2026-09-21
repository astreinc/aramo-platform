// NoteCategory — RN-1 (LOCKED) mirror of the Prisma `activity.NoteCategory`
// enum. ORTHOGONAL to ActivityType: a note is always ActivityType.note, and its
// NoteCategory says what the note is *about* (for filtering/scanning). Ratified
// 7-value set (Q4). Default GENERAL. String + membership check pattern (mirrors
// activity-type.ts); the FE mirrors this list 1:1, guarded by a drift test.
export const NOTE_CATEGORY_VALUES = [
  'GENERAL',
  'CLIENT_INTERACTION',
  'HIRING_TEAM',
  'COMMERCIAL',
  'INTERVIEW_FEEDBACK',
  'DECISION',
  'RISK_BLOCKER',
] as const;

export type NoteCategory = (typeof NOTE_CATEGORY_VALUES)[number];

export const DEFAULT_NOTE_CATEGORY: NoteCategory = 'GENERAL';

export function isNoteCategory(value: unknown): value is NoteCategory {
  return (
    typeof value === 'string' &&
    (NOTE_CATEGORY_VALUES as readonly string[]).includes(value)
  );
}
