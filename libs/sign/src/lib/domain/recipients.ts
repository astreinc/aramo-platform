// Aramo-Sign-Unified-Product-Amendment-M-A5-Recipient-Kinds-Hosted-Self-Signing-v1_0-LOCKED
// §1.3 — the ONE place that decides who the "signing recipients" are and whose turn
// it is. Every site that computes turn, completion, invitations, reminders,
// readiness, notifications or fan-out uses these helpers, so the sequential-turn
// rule cannot drift between them.
//
//   SIGNER            signs through an emailed link (and, when bound, self-signs).
//   IN_PERSON_SIGNER  signs on the host's device in a HOSTED session. Never emailed a
//                     signing link (email optional; when given, it receives the copy).
//   RECEIVES_COPY     never signs: no fields, no session, no turn, never blocks
//                     completion, never reminded.
//   WITNESS           Feature-Parity directive (2bd74ca5) §1.17 — signs (attests) through
//                     an emailed link, for ONE other signing recipient
//                     (witness_for_signer_id), and only after that signer has signed.
//                     Blocks completion like any signing recipient.

export const RECIPIENT_KINDS = ['SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY', 'WITNESS'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const SIGNING_RECIPIENT_KINDS: readonly RecipientKind[] = ['SIGNER', 'IN_PERSON_SIGNER', 'WITNESS'];

export const COPY_DELIVERIES = ['ON_SEND', 'ON_COMPLETION', 'BOTH'] as const;
export type CopyDelivery = (typeof COPY_DELIVERIES)[number];

// M-A5 §1.4 — at most 10 signing recipients (MAX_SIGNERS, unchanged) and 10 copies.
export const MAX_COPY_RECIPIENTS = 10;

// M-A5 §3.2 / §4.2 — hosted and self-sign sessions last 30 minutes.
export const HOSTED_SESSION_TTL_MS = 30 * 60 * 1000;
export const SELF_SIGN_SESSION_TTL_MS = 30 * 60 * 1000;

// M-A5 §5 — where a signing session came from (NULL = a legacy session).
export type SessionOrigin = 'LINK' | 'INBOX' | 'HOSTED' | 'SELF';

// The ledger events M-A5 adds.
export const COPY_DELIVERY_ISSUED_EVENT = 'COPY_DELIVERY_ISSUED';
export const HOSTED_SESSION_STARTED_EVENT = 'HOSTED_SESSION_STARTED';
export const SELF_SIGN_SESSION_ISSUED_EVENT = 'SELF_SIGN_SESSION_ISSUED';
// Feature-Parity directive §1.17 — the ledger events witness and delegate signing add.
export const WITNESS_ATTESTED_EVENT = 'WITNESS_ATTESTED';
export const SIGNER_DELEGATED_EVENT = 'SIGNER_DELEGATED';

// A Prisma `where` fragment selecting the signing recipients of an envelope.
export const SIGNING_RECIPIENT_WHERE = { recipient_kind: { in: [...SIGNING_RECIPIENT_KINDS] } };

interface KindRow {
  recipient_kind?: string | null;
}
interface TurnRow extends KindRow {
  id: string;
  status: string;
  signing_order: number;
  // §1.17 — set for a WITNESS only (rows read without it are never witnesses).
  witness_for_signer_id?: string | null;
}

// A row without recipient_kind (an older read) is a SIGNER: the column default.
export function recipientKindOf(r: KindRow): RecipientKind {
  const k = r.recipient_kind;
  return k === 'IN_PERSON_SIGNER' || k === 'RECEIVES_COPY' || k === 'WITNESS' ? k : 'SIGNER';
}

export function isWitness(r: KindRow): boolean {
  return recipientKindOf(r) === 'WITNESS';
}

// §1.17 — a witness may act only once the signer it witnesses has SIGNED. Every
// other recipient is always "ready" by this rule (turn rules still apply).
export function witnessReady(rows: readonly { id: string; status: string }[], r: KindRow & { witness_for_signer_id?: string | null }): boolean {
  if (!isWitness(r)) return true;
  const principal = rows.find((x) => x.id === r.witness_for_signer_id);
  return principal !== undefined && principal.status === 'SIGNED';
}

export function isSigningRecipient(r: KindRow): boolean {
  return recipientKindOf(r) !== 'RECEIVES_COPY';
}

export function isCopyRecipient(r: KindRow): boolean {
  return recipientKindOf(r) === 'RECEIVES_COPY';
}

// Only a SIGNER (and, §1.17, a WITNESS) is emailed a signing link (invitation and reminder).
export function isLinkSigner(r: KindRow): boolean {
  const k = recipientKindOf(r);
  return k === 'SIGNER' || k === 'WITNESS';
}

export function signingRecipients<T extends KindRow>(rows: readonly T[]): T[] {
  return rows.filter(isSigningRecipient);
}

export function copyRecipients<T extends KindRow & { copy_delivery?: string | null }>(rows: readonly T[], when: 'SEND' | 'COMPLETION'): T[] {
  const wanted = when === 'SEND' ? ['ON_SEND', 'BOTH'] : ['ON_COMPLETION', 'BOTH'];
  return rows.filter((r) => isCopyRecipient(r) && wanted.includes(r.copy_delivery ?? ''));
}

// Every signing recipient has signed (the envelope completes). Copies never block.
export function allSigningRecipientsSigned(rows: readonly (KindRow & { status: string })[]): boolean {
  const signing = signingRecipients(rows);
  return signing.length > 0 && signing.every((s) => s.status === 'SIGNED');
}

// Multi-Signer §4 — in a SEQUENTIAL envelope the recipient whose turn it is: the
// lowest signing_order among signing recipients who have not SIGNED (null when
// every one has). Copies never take a turn.
export function currentTurnOf<T extends TurnRow>(rows: readonly T[]): T | null {
  const open = signingRecipients(rows)
    .filter((s) => s.status !== 'SIGNED')
    .sort((a, b) => a.signing_order - b.signing_order);
  return open[0] ?? null;
}

// The same rule, read from the database (inside the caller's transaction).
export async function currentTurnSignerId(
  client: { signer: { findFirst(args: { where: Record<string, unknown>; orderBy: { signing_order: 'asc' }; select: { id: true } }): Promise<{ id: string } | null> } },
  tenant_id: string,
  envelope_id: string,
): Promise<string | null> {
  const next = await client.signer.findFirst({
    where: { tenant_id, envelope_id, status: { not: 'SIGNED' }, ...SIGNING_RECIPIENT_WHERE },
    orderBy: { signing_order: 'asc' },
    select: { id: true },
  });
  return next?.id ?? null;
}

// Whether `signer_id` may act now: PARALLEL — any signing recipient; SEQUENTIAL —
// only the one whose turn it is.
export function mayActNow<T extends TurnRow>(routing_mode: string, rows: readonly T[], signer_id: string): boolean {
  const row = rows.find((r) => r.id === signer_id);
  if (row === undefined || !isSigningRecipient(row)) return false;
  if (!witnessReady(rows, row)) return false;
  if (routing_mode !== 'SEQUENTIAL') return true;
  return currentTurnOf(rows)?.id === signer_id;
}

// The recipients emailed a signing link at send: PARALLEL — every SIGNER;
// SEQUENTIAL — the first signing recipient, when it is a SIGNER (an in-person signer
// is started by the host instead). §1.17 — a WITNESS is never invited at send (its
// signer has not signed yet); it is invited when that signer completes.
export function invitedAtSend<T extends TurnRow>(routing_mode: string, rows: readonly T[]): T[] {
  if (routing_mode === 'SEQUENTIAL') {
    const first = currentTurnOf(rows);
    return first !== null && isLinkSigner(first) && witnessReady(rows, first) ? [first] : [];
  }
  return signingRecipients(rows).filter((r) => isLinkSigner(r) && witnessReady(rows, r));
}

// §1.17 — the witnesses of `signer_id` that are waiting to attest (emailed when that
// signer completes, in a PARALLEL envelope).
export function pendingWitnessesOf<T extends TurnRow>(rows: readonly T[], signer_id: string): T[] {
  return rows.filter((r) => isWitness(r) && r.witness_for_signer_id === signer_id && (r.status === 'PENDING' || r.status === 'VIEWED'));
}

// Aramo Sign W2 §A3.5 (Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED) —
// the sender list's "Waiting for you": a SENT / IN_PROGRESS, unexpired envelope whose ONLY
// currently actionable recipient steps (pending signing recipients for whom mayActNow holds)
// belong to `user_id`. A step is the user's when the recipient is bound to the user
// (bound_user_id, M-A5 §4.1) or is a SIGNER / WITNESS addressed to the user's proven current
// email on an envelope sent at or after that proof (the W2 discovery rule, W-1 / W-2).
export function awaitingYou<T extends TurnRow & { email?: string | null; bound_user_id?: string | null }>(
  envelope: { status: string; routing_mode: string; sent_at: Date | null; expires_at?: Date | null },
  rows: readonly T[],
  user_id: string,
  proof: { email: string; proven_at: Date } | null,
  now: Date = new Date(),
): boolean {
  return awaitingYouSteps(envelope, rows, user_id, proof, now) !== null;
}

// The same rule, returning the user's actionable steps (each tagged with whether it is
// proven by the W2 discovery rule), or null when the envelope is not awaiting the user.
export function awaitingYouSteps<T extends TurnRow & { email?: string | null; bound_user_id?: string | null }>(
  envelope: { status: string; routing_mode: string; sent_at: Date | null; expires_at?: Date | null },
  rows: readonly T[],
  user_id: string,
  proof: { email: string; proven_at: Date } | null,
  now: Date = new Date(),
): Array<{ row: T; proven: boolean }> | null {
  if (envelope.status !== 'SENT' && envelope.status !== 'IN_PROGRESS') return null;
  if (envelope.expires_at !== undefined && envelope.expires_at !== null && envelope.expires_at.getTime() <= now.getTime()) return null;
  const actionable = signingRecipients(rows).filter((r) => (r.status === 'PENDING' || r.status === 'VIEWED') && mayActNow(envelope.routing_mode, rows, r.id));
  if (actionable.length === 0) return null;
  const provenFor = (r: T): boolean =>
    proof !== null &&
    isLinkSigner(r) &&
    typeof r.email === 'string' &&
    r.email.trim().toLowerCase() === proof.email &&
    envelope.sent_at !== null &&
    envelope.sent_at.getTime() >= proof.proven_at.getTime();
  const steps = actionable.map((row) => ({ row, proven: provenFor(row) }));
  return steps.every((s) => s.proven || s.row.bound_user_id === user_id) ? steps : null;
}
