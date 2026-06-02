// AttachmentOwnerType — directive §4 ruling. Typed discriminator with
// all 4 values defined. A4 wires + tests the `talent` path ONLY; later
// batches add requisition / company / contact owner validation without
// a schema migration.
export const ATTACHMENT_OWNER_TYPES = [
  'talent',
  'requisition',
  'company',
  'contact',
] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

export function isAttachmentOwnerType(
  value: unknown,
): value is AttachmentOwnerType {
  return (
    typeof value === 'string' &&
    (ATTACHMENT_OWNER_TYPES as readonly string[]).includes(value)
  );
}
