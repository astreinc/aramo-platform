import { PIPELINE_STATUS_LABELS, PIPELINE_STATUS_VALUES, type PipelineStatus } from '../pipeline/types';

// Presentation of the system-written pipeline transition note. libs/pipeline
// stores the audit text `pipeline <from> -> <to>[: <note>][ [evidence kind:id]]`
// (and `pipeline no_contact -> voided (accidental-add correction: <REASON>)` for
// the VOID correction) on the Activity row. Those rows are durable history, so the
// recruiter-facing wording is applied HERE, at display time, which also covers
// every row written before this change. Only a note that matches that exact shape
// with two KNOWN pipeline statuses is rewritten; anything else (a human note, an
// unknown status) is returned verbatim, never guessed at.

const TRANSITION = /^pipeline ([a-z_]+) -> ([a-z_]+)([\s\S]*)$/;
// The evidence provenance suffix carries internal ids — not recruiter-facing.
const EVIDENCE_SUFFIX = /\s*\[evidence [^\]]*\]\s*$/;
const CORRECTION = /^\s*\(accidental-add correction: ([A-Z_]+)\)\s*$/;

function isPipelineStatus(s: string): s is PipelineStatus {
  return (PIPELINE_STATUS_VALUES as readonly string[]).includes(s);
}

export interface PipelineTransition {
  readonly from: PipelineStatus;
  readonly to: PipelineStatus;
  // The recruiter's free-text note on the transition (evidence ids stripped); null when none.
  readonly note: string | null;
}

// The structured form of a system transition note, or null when the note is not one.
export function parsePipelineTransition(notes: string): PipelineTransition | null {
  const m = TRANSITION.exec(notes);
  if (m === null) return null;
  const [, from, to, rest] = m as unknown as [string, string, string, string];
  if (!isPipelineStatus(from) || !isPipelineStatus(to)) return null;
  const tail = rest.replace(EVIDENCE_SUFFIX, '');
  const note = tail.startsWith(':') ? tail.slice(1).trim() : '';
  return { from, to, note: note === '' ? null : note };
}

export function formatActivityNote(notes: string): string {
  const m = TRANSITION.exec(notes);
  if (m === null) return notes;
  const [, from, to, rest] = m as unknown as [string, string, string, string];
  if (!isPipelineStatus(from) || !isPipelineStatus(to)) return notes;

  const arrow = `${PIPELINE_STATUS_LABELS[from]} → ${PIPELINE_STATUS_LABELS[to]}`;
  const tail = rest.replace(EVIDENCE_SUFFIX, '');
  if (tail.trim() === '') return arrow;

  const correction = CORRECTION.exec(tail);
  if (correction !== null) {
    // The `voided` label already reads "Removed (added by mistake)".
    const reason = correction[1] ?? '';
    if (reason === 'ADDED_BY_MISTAKE') return arrow;
    return `${arrow} (${reason.toLowerCase().replace(/_/g, ' ')})`;
  }
  if (tail.startsWith(':')) {
    const note = tail.slice(1).trim();
    return note === '' ? arrow : `${arrow} — ${note}`;
  }
  return `${arrow}${tail}`;
}
