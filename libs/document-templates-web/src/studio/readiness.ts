import {
  isCanonicalStudioHtml,
  studioBlocksToHtml,
  studioPlainText,
  studioVariableKeys,
  type StudioBlock,
  type StudioChipState,
} from '../studio-codec';

import type { WithdrawalState } from './data-source';

// PLATFORM-UX-1 F-9 (handoff §10.6 Checks, §10.7) — the publishing checks. DERIVED,
// never stored: every render recomputes them from the draft, the save revision and the
// preview revision.
//   ready     = no failing required check
//   previewed = !dirty && previewedRev === savedRev

export type CheckSeverity = 'fail' | 'warn';

export interface CheckItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly ok: boolean;
  /** fail = required (blocks publishing) · warn = does not block. */
  readonly severity: CheckSeverity;
  /** A variable the "Remove from draft" fix removes. */
  readonly fixKey?: string;
}

export interface ReadinessInput {
  readonly title: string;
  readonly blocks: readonly StudioBlock[];
  readonly chipState: (key: string) => StudioChipState;
  readonly dirty: boolean;
  readonly savedRev: number;
  readonly previewedRev: number | null;
  /** null = the context has no withdrawal (the check is left out). */
  readonly withdrawal: WithdrawalState | null;
  /** TEMPLATE-STUDIO-1 S-1 — the context's unknown-variable detail (default: the platform's). */
  readonly unknownDetail?: string;
}

export interface Readiness {
  readonly items: readonly CheckItem[];
  readonly fails: number;
  readonly warns: number;
  readonly passed: number;
  readonly total: number;
  readonly ready: boolean;
  readonly previewed: boolean;
  /** Distinct variable key → uses in the draft. */
  readonly used: ReadonlyMap<string, number>;
}

export function variableUsage(blocks: readonly StudioBlock[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const b of blocks) for (const k of studioVariableKeys(b.value)) used.set(k, (used.get(k) ?? 0) + 1);
  return used;
}

export function isPreviewed(dirty: boolean, savedRev: number, previewedRev: number | null): boolean {
  return !dirty && previewedRev === savedRev;
}

export function deriveReadiness(input: ReadinessInput): Readiness {
  const used = variableUsage(input.blocks);
  const keys = Array.from(used.keys());
  const unknown = keys.filter((k) => input.chipState(k) === 'unknown');
  const inactive = keys.filter((k) => input.chipState(k) === 'inactive');
  const hasText = input.blocks.some((b) => studioPlainText(b.value).length > 0);
  const saved = !input.dirty;
  const previewed = isPreviewed(input.dirty, input.savedRev, input.previewedRev);
  const allowedOnly = isCanonicalStudioHtml(studioBlocksToHtml(input.blocks));

  const items: CheckItem[] = [
    { id: 'title', label: 'Document title is set', ok: input.title.trim().length > 0, severity: 'fail', detail: 'Shown as the document heading and in Sign.' },
    { id: 'content', label: 'Draft has content', ok: hasText, severity: 'fail', detail: 'Add at least one paragraph.' },
    ...unknown.map<CheckItem>((k) => ({
      id: `unknown:${k}`,
      label: `Unknown variable {{${k}}}`,
      ok: false,
      severity: 'fail',
      detail: input.unknownDetail ?? 'Not in Template variables. Remove it, or add it on the Template variables page first.',
      fixKey: k,
    })),
    ...inactive.map<CheckItem>((k) => ({
      id: `inactive:${k}`,
      label: `Inactive variable {{${k}}}`,
      ok: false,
      severity: 'warn',
      detail: 'Renders its sample today but tenants can’t bind it. Consider removing it.',
      fixKey: k,
    })),
    { id: 'format', label: 'Only allowed formatting', ok: allowedOnly, severity: 'fail', detail: 'Paragraphs, H2, bold, italic, underline, lists, line breaks and variables.' },
    { id: 'saved', label: 'Draft saved', ok: saved, severity: 'fail', detail: 'Save the draft before previewing.' },
    { id: 'previewed', label: 'Previewed after the last save', ok: previewed, severity: 'fail', detail: 'Open Preview to check the saved draft with sample values.' },
    ...(input.withdrawal !== null
      ? [{ id: 'withdrawn', label: 'Template is not withdrawn', ok: input.withdrawal !== 'IN_EFFECT', severity: 'fail', detail: 'Withdrawn templates can’t be published.' } satisfies CheckItem]
      : []),
  ];
  const fails = items.filter((i) => !i.ok && i.severity === 'fail').length;
  const warns = items.filter((i) => !i.ok && i.severity === 'warn').length;
  return {
    items,
    fails,
    warns,
    passed: items.filter((i) => i.ok).length,
    total: items.length,
    ready: fails === 0,
    previewed,
    used,
  };
}

/** "6 of 8 checks pass · 1 warning". */
export function checksLine(r: Readiness): string {
  const w = r.warns > 0 ? ` · ${r.warns} warning${r.warns > 1 ? 's' : ''}` : '';
  return `${r.passed} of ${r.total} checks pass${w}`;
}

/** The readiness pill label ("Ready to publish" · "3 issues before publishing"; short below 1200px). */
export function readinessLabel(r: Readiness, wide: boolean): string {
  if (r.ready) return wide ? 'Ready to publish' : 'Ready';
  return `${r.fails}${r.fails === 1 ? ' issue' : ' issues'}${wide ? ' before publishing' : ''}`;
}
