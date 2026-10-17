import type { ReactNode } from 'react';

import { bandLabel, bandTone } from './band-map';
import { stageLabel, stageTone, type PipelineStatus } from './stage-map';

// D-ORG-3 — PillTone / StatusPill / Tag / TagList moved to @aramo/fe-foundation
// (move-not-fork; libs/org-admin-web renders the same chips). Re-exported here so
// every `../ui/pills` and `../ui` call-site is unchanged.
export { StatusPill, Tag, TagList, type PillTone } from '@aramo/fe-foundation';

interface StagePillProps {
  readonly status: PipelineStatus;
}

// Pipeline stage chip. Takes the canonical PipelineStatus and projects it to
// the recruiter-facing label + the stage tone (stage-map.ts) — so every
// surface renders a stage identically and a new BE status can't drift the
// colour (stage-map.spec.ts guards exhaustiveness).
export function StagePill({ status }: StagePillProps) {
  return (
    <span className={`rc-pill rc-stagepill rc-pill--${stageTone(status)}`}>
      {stageLabel(status)}
    </span>
  );
}

interface BandPillProps {
  /** A PresentationBand value off the wire, or null when no TrustState exists. */
  readonly band: string | null;
}

// Trust-band chip. Takes a per-dimension presentation band and projects it to
// the human label + band tone (band-map.ts, a hand-mirror of the talent-trust
// PRESENTATION_BANDS vocab, drift-guarded by band-map.spec.ts). R10: a band is
// a LABEL, never a number or a star — a null band renders "Not established".
export function BandPill({ band }: BandPillProps) {
  return (
    <span className={`rc-pill rc-bandpill rc-pill--${bandTone(band)}`}>
      {bandLabel(band)}
    </span>
  );
}

export type ConstraintState = 'pass' | 'partial' | 'fail';

interface ConstraintChipProps {
  readonly state: ConstraintState;
  readonly label: ReactNode;
  readonly value: ReactNode;
}

// Pass/partial/fail compliance chip. PER LEAD GAP #4: the submittal gate does
// NOT compute these from TalentJobExamination (that's Core, a later
// by-product). This atom is retained ONLY for non-examination, contract-backed
// uses; the submittal surface uses the three attestations as its gate.
export function ConstraintChip({ state, label, value }: ConstraintChipProps) {
  return (
    <div className={`rc-constraint rc-constraint--${state}`}>
      <span className="rc-constraint__ico" aria-hidden="true">
        {state === 'partial' ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 8v5M12 16h.01" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </span>
      <span className="rc-constraint__lab">{label}</span>
      <span className="rc-constraint__val">{value}</span>
    </div>
  );
}
