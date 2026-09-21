// NoteEventType — RN-1-A1 (LOCKED) mirror of the Prisma `activity.NoteEventType`
// enum. The append-only ActivityNoteEvent lifecycle-ledger event kinds. Exactly
// one event is appended, transactionally, per real state transition.
export const NOTE_EVENT_TYPE_VALUES = [
  'CREATED',
  'PINNED',
  'UNPINNED',
  'REDACTED',
] as const;

export type NoteEventType = (typeof NOTE_EVENT_TYPE_VALUES)[number];

export function isNoteEventType(value: unknown): value is NoteEventType {
  return (
    typeof value === 'string' &&
    (NOTE_EVENT_TYPE_VALUES as readonly string[]).includes(value)
  );
}
