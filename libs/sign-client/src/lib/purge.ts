// APP-DELETED-1 A2 (LOCKED 2026-11-27; Retention & Purge, UAT DEL-10) — the envelope purge:
// ONE copy for Sign web and the Aramo Sign app. The server decides who may purge or cancel
// (`actions.purge` / `actions.dequeue_purge`) and returns `SignEnvelopePurgeResult` ({ purge })
// from both routes. A purge waits 14 days in the queue and can be cancelled until then.
//
// Pure TypeScript ESM, no dependency (type:client-shared).

export type PurgeLevel = 'DOCUMENTS' | 'DOCUMENTS_AND_METADATA' | 'DOCUMENTS_AND_METADATA_AND_REDACT';

export const PURGE_LEVELS: readonly { readonly key: PurgeLevel; readonly label: string; readonly help: string }[] = [
  { key: 'DOCUMENTS', label: 'Documents', help: 'Signed documents and the certificate PDF are deleted. Envelope details and history stay.' },
  { key: 'DOCUMENTS_AND_METADATA', label: 'Documents and details', help: 'Also clears the subject, message, document names and entered field values.' },
  {
    key: 'DOCUMENTS_AND_METADATA_AND_REDACT',
    label: 'Documents, details and personal data',
    help: 'Also removes recipient names, email addresses and IP addresses from the envelope and its history.',
  },
];

export function purgeLevelLabel(level: PurgeLevel | null | undefined): string {
  return PURGE_LEVELS.find((l) => l.key === level)?.label ?? 'Documents';
}

export const PURGE_CONFIRM_WORD = 'PURGE';

export function purgeConfirmed(typed: string): boolean {
  return typed === PURGE_CONFIRM_WORD;
}

export const PURGE_COPY = {
  open: 'Purge…',
  title: 'Purge this envelope?',
  body: 'The envelope waits 14 days in the purge queue, then the chosen data is deleted permanently for everyone. You can cancel during those 14 days.',
  level_label: 'What is purged',
  confirm_label: 'Type PURGE to confirm',
  queue: 'Queue purge',
  queued: 'Purge scheduled',
  cancel: 'Cancel purge',
  cancelled: 'Purge cancelled',
} as const;

export interface PurgeStateView {
  readonly state: 'QUEUED' | 'DEQUEUED' | 'EXECUTED';
  readonly level: PurgeLevel;
  readonly due_at: string | null;
  readonly executed_at: string | null;
}

/** The banner line for a queued or executed purge; null when none is shown (none, or cancelled). */
export function purgeBannerLine(purge: PurgeStateView | null | undefined, formatDate: (iso: string | null) => string): string | null {
  if (purge == null || purge.state === 'DEQUEUED') return null;
  const what = purgeLevelLabel(purge.level).toLowerCase();
  if (purge.state === 'EXECUTED')
    return `This envelope’s documents were purged on ${formatDate(purge.executed_at)} (${what}). They can’t be downloaded or recovered. Its history remains.`;
  return `Purge scheduled: ${what} will be deleted permanently on ${formatDate(purge.due_at)}.`;
}

export function envelopePurgeRoute(envelopeId: string): string {
  return `/v1/sign/sender/envelopes/${encodeURIComponent(envelopeId)}/purge`;
}

export function envelopeDequeuePurgeRoute(envelopeId: string): string {
  return `/v1/sign/sender/envelopes/${encodeURIComponent(envelopeId)}/purge/dequeue`;
}
