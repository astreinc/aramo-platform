// APP-DELETED-1 (LOCKED 2026-11-27; Retention & Purge W5) — the sender's Deleted folder: ONE copy
// for Sign web and the Aramo Sign app. The server decides whether an envelope may be deleted or
// restored (`actions.delete` / `actions.restore`); the clients only show these words.
// Delete hides a finished envelope for the caller's organization only; recipients keep their
// copies; Restore brings it back until a purge has run. A draft is not deleted this way (it is
// removed outright through `actions.delete_draft`).
//
// Pure TypeScript ESM, no dependency (type:client-shared).

export const ENVELOPE_DELETE_COPY = {
  delete_title: 'Delete this envelope?',
  delete_body:
    'It moves to Deleted and is hidden for your organization only. Recipients keep their copies. You can restore it until it is purged.',
  delete_confirm: 'Delete',
  deleted: 'Moved to Deleted',
  restore_title: 'Restore this envelope?',
  restore_body: 'It moves back to your envelopes.',
  restore_confirm: 'Restore',
  restored: 'Envelope restored',
  /** Why an open (waiting) envelope offers no Delete. */
  delete_when_finished: 'Finish or void this envelope before deleting it.',
  deleted_help:
    'Envelopes you deleted are hidden only for your organization. Recipients keep their copies. Restore an envelope to move it back.',
  deleted_empty: 'Nothing in Deleted',
} as const;

export type EnvelopeDeleteCopyKey = keyof typeof ENVELOPE_DELETE_COPY;

/** The sender routes behind the copy (POST, empty body). */
export function envelopeDeleteRoute(envelopeId: string): string {
  return `/v1/sign/sender/envelopes/${encodeURIComponent(envelopeId)}/delete`;
}

export function envelopeRestoreRoute(envelopeId: string): string {
  return `/v1/sign/sender/envelopes/${encodeURIComponent(envelopeId)}/restore`;
}
