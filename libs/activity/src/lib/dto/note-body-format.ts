// NoteBodyFormat — RN-1 (LOCKED) mirror of the Prisma `activity.NoteBodyFormat`
// enum. RN-1 is plain_text ONLY (D-5: no arbitrary Markdown on an audit/business
// record). Server-set, not client-chosen. Controlled rich text is a governed
// RN-3 option gated behind this discriminator.
export const NOTE_BODY_FORMAT_VALUES = ['plain_text'] as const;

export type NoteBodyFormat = (typeof NOTE_BODY_FORMAT_VALUES)[number];

export const DEFAULT_NOTE_BODY_FORMAT: NoteBodyFormat = 'plain_text';

export function isNoteBodyFormat(value: unknown): value is NoteBodyFormat {
  return (
    typeof value === 'string' &&
    (NOTE_BODY_FORMAT_VALUES as readonly string[]).includes(value)
  );
}
