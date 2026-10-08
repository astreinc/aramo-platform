import type { PillTone } from '../ui';

import type { TalentIntakeDuplicate } from './talent-intake-api';

// Talent Draft Recovery — the ONE shared draft→recruiter presentation mapper
// (§10). Every surface (In progress tab, All-Talent strip, Add-talent cue, Add
// Talent recovery, My Desk) derives its label/tone/reason from here; no component
// re-derives the mapping. Recruiter-facing vocabulary is locked — raw backend
// states (FAILED/PARTIAL/PROCESSING/QUEUED) are NEVER shown.
//
// Authority: `canCreate` is the backend create authority (`admissible` = canonical
// name/email/phone), NOT the completeness checklist. "Ready to create" (green)
// appears only when the backend would admit the Talent and no active-email
// duplicate blocks it.

export type DraftTone = 'blue' | 'green' | 'amber';

export interface DraftPresentation {
  label: string;
  tone: DraftTone;
  pillTone: PillTone; // mapped onto the shared StatusPill tone token
  reason: string | null; // amber needs-attention reason line
  needsAttention: boolean;
  canCreate: boolean;
  requiredMet: number;
  requiredTotal: number;
}

// The minimal authoritative shape the mapper consumes — satisfied by both the
// list item (coarser: no duplicate) and the full view.
export interface DraftStateInput {
  processing_status: string;
  review_status: string;
  promoted_talent_record_id: string | null;
  required: { met: number; total: number };
  admissible: boolean;
  duplicate?: TalentIntakeDuplicate | null;
  failure?: string | null;
  warning?: string | null;
}

const READING = new Set(['UPLOADED', 'QUEUED', 'PROCESSING']);

function toPillTone(tone: DraftTone): PillTone {
  return tone === 'green' ? 'ok' : tone === 'amber' ? 'warn' : 'info';
}

export function presentDraft(d: DraftStateInput): DraftPresentation {
  const dup = d.duplicate ?? null;
  const dupBlocks = dup !== null && dup.continue_anyway === false;
  const canCreate = d.admissible && d.promoted_talent_record_id === null && !dupBlocks;
  const base = { canCreate, requiredMet: d.required.met, requiredTotal: d.required.total };
  const make = (
    label: string,
    tone: DraftTone,
    reason: string | null,
    needsAttention: boolean,
  ): DraftPresentation => ({ label, tone, pillTone: toPillTone(tone), reason, needsAttention, ...base });

  if (d.promoted_talent_record_id !== null) return make('Talent created', 'green', null, false);

  // Precedence: a possible existing Talent and extraction trouble are "Needs
  // attention" ahead of any ready/reading signal.
  if (dup !== null) {
    const name = (dup.display_name ?? '').trim();
    return make(
      'Needs attention',
      'amber',
      name !== ''
        ? `Possible existing Talent — ${name} matches email`
        : 'Possible existing Talent — email matches',
      true,
    );
  }
  if (d.processing_status === 'FAILED') {
    return make(
      'Needs attention',
      'amber',
      (d.failure ?? '').trim() || "Couldn't read résumé — enter details manually",
      true,
    );
  }
  if (d.processing_status === 'PARTIAL') {
    return make(
      'Needs attention',
      'amber',
      (d.warning ?? '').trim() || "Couldn't fully read the résumé — review the details",
      true,
    );
  }
  if (READING.has(d.processing_status)) {
    return make('Reading résumé', 'blue', null, false);
  }
  // READY (extraction complete, no failure/duplicate).
  return canCreate
    ? make('Ready to create', 'green', null, false)
    : make('Ready to review', 'blue', null, false);
}

// Draft identity for a recovery row — review/extracted name precedence, then the
// filename, then a safe fallback. NEVER a fabricated TalentRecord identity (§5.1).
export function draftTitle(d: {
  display_name?: string | null;
  source_filename: string | null;
}): { title: string; file: string } {
  const name = (d.display_name ?? '').trim();
  const file = (d.source_filename ?? '').trim();
  if (name !== '') return { title: name, file: file || 'résumé' };
  if (file !== '') return { title: file, file };
  return { title: 'Name not found yet', file: 'résumé' };
}

// In-progress = unpromoted drafts (the recovery population). The server already
// filters promoted drafts from the list; this is a defensive local guard.
export function inProgressDrafts<T extends { promoted_talent_record_id: string | null }>(
  items: T[],
): T[] {
  return items.filter((d) => d.promoted_talent_record_id === null);
}

// Add-talent cue dot (§7): amber when any in-progress draft needs attention, else
// blue when any in-progress work exists, else null (no dot).
export function addTalentDotTone(items: DraftStateInput[]): 'blue' | 'amber' | null {
  const open = inProgressDrafts(items);
  if (open.length === 0) return null;
  return open.some((d) => presentDraft(d).needsAttention) ? 'amber' : 'blue';
}

// All-Talent recovery strip copy (§6) — pluralized.
export function recoveryStripText(n: number): string {
  return `${n} ${n === 1 ? 'talent' : 'talents'} you started adding`;
}

// Add-talent cue tooltip (§7) — "1 in progress" / "4 in progress".
export function inProgressTooltip(n: number): string {
  return `${n} in progress`;
}
