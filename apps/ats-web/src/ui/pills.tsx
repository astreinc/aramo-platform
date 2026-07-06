import type { ReactNode } from 'react';

import { bandLabel, bandTone } from './band-map';
import { stageLabel, stageTone, type PipelineStatus } from './stage-map';

export type PillTone =
  | 'neutral'
  | 'brand'
  | 'info'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'hot';

interface StatusPillProps {
  readonly tone: PillTone;
  /** Render a leading current-colour dot (the mockup "Open ·" affordance). */
  readonly dot?: boolean;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}

// Generic status chip — muted same-family fill. Used for requisition status
// (Open / Hot / Intake / Closed) and any entity-state badge. The semantic
// tone is the caller's decision (mapping helpers live with each surface so
// the design-system atom stays domain-neutral).
export function StatusPill({ tone, dot, icon, children }: StatusPillProps) {
  return (
    <span className={`rc-pill rc-pill--${tone}${dot ? ' rc-pill__dot' : ''}`}>
      {icon}
      {children}
    </span>
  );
}

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

interface TagProps {
  readonly children: ReactNode;
}

export function Tag({ children }: TagProps) {
  return <span className="rc-tag">{children}</span>;
}

interface TagListProps {
  readonly tags: readonly string[];
  /** Max chips before collapsing the remainder into a "+N" tag. */
  readonly max?: number;
}

// Skill/label chips with overflow. Presentational only — splitting freetext
// (e.g. key_skills) into tags is the caller's job (gap #9).
export function TagList({ tags, max = 3 }: TagListProps) {
  const shown = tags.slice(0, max);
  const overflow = tags.length - shown.length;
  return (
    <span className="rc-tags">
      {shown.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
      {overflow > 0 ? <Tag>{`+${overflow}`}</Tag> : null}
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
