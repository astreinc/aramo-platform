import type { ReactNode } from 'react';

import { ChainPreview } from './ChainPreview';
import { CommercialRequestDialog, RequestField, type CommercialCommitTone } from './CommercialRequestDialog';
import './governance-components.css';

// CCP-B5 (handoff §5.10 "Dialog pattern", §6 ChainPreview) — the change-request dialog of
// the commercial console, on the fe-foundation Dialog (Radix: focus trap, Esc closes, focus
// returns to the opener). Body, in order: the caller's fields → Before → after diff → chain
// preview strip → the refusal alert. Footer: Cancel · commit. The commit carries the
// request's tone (terracotta for privileged requests, danger for removals, midnight
// otherwise) and sits at 45% until the caller says the request is complete.
//
// Local to platform-web (PLATFORM-UX-1 R-3; no fe-foundation edit).
//
// Merge train TD-MERGE-13: CCP-B2 and CCP-B5 each built this dialog and the chain strip from the
// same design block. One implementation is kept, CCP-B2's CommercialRequestDialog / ChainPreview;
// this file is now a thin adapter that keeps the B5 call sites' props (Reason + Evidence fields,
// [setting, before, after] rows, the chain as data).

export type GovernanceTone = 'privileged' | 'danger' | 'normal';

export interface ChainPreviewProps {
  /** "Policy change". */
  readonly label: string;
  /** "Finance → Owner". */
  readonly steps: string;
  /** "v1". */
  readonly policy: string;
  /** "72 h". */
  readonly ttl: string;
  /** The chain is not fulfillable by distinct people right now (handoff §3.2). */
  readonly notFulfillable?: boolean;
}

export interface GovernanceRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly sub: ReactNode;
  /** The request's own fields, above Reason and Evidence. */
  readonly children?: ReactNode;
  readonly reason: string;
  readonly onReason: (v: string) => void;
  readonly evidence: string;
  readonly onEvidence: (v: string) => void;
  /** Before → after rows: [setting, before, after]. */
  readonly diff: readonly (readonly [string, string, string])[];
  readonly chain: ChainPreviewProps | null;
  /** A refusal that blocks the commit (role="alert"), e.g. the last-owner rule. */
  readonly alert?: string | null;
  /** The error of the last commit (role="alert"). */
  readonly error?: string | null;
  readonly commitLabel: string;
  readonly tone?: GovernanceTone;
  readonly canCommit: boolean;
  readonly busy?: boolean;
  readonly onCommit: () => void;
}

const TONE: Readonly<Record<GovernanceTone, CommercialCommitTone>> = { privileged: 'terra', danger: 'danger', normal: 'mid' };

export function GovernanceRequestDialog({
  open,
  onOpenChange,
  title,
  sub,
  children,
  reason,
  onReason,
  evidence,
  onEvidence,
  diff,
  chain,
  alert = null,
  error = null,
  commitLabel,
  tone = 'privileged',
  canCommit,
  busy = false,
  onCommit,
}: GovernanceRequestDialogProps) {
  const refusal = alert ?? error;
  return (
    <CommercialRequestDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      sub={sub}
      diff={diff.map(([field, before, after]) => ({ field, before, after, changed: before !== after }))}
      chain={
        chain !== null ? (
          <ChainPreview label={chain.label} steps={chain.steps.split(' → ')} policy={chain.policy} window={chain.ttl} notFulfillable={chain.notFulfillable ?? false} />
        ) : null
      }
      alert={refusal !== null ? refusal : null}
      commitLabel={commitLabel}
      tone={TONE[tone]}
      canCommit={canCommit && alert === null}
      busy={busy}
      onCommit={onCommit}
    >
      {children}
      <RequestField label="Reason" value={reason} onChange={onReason} placeholder="Why this change is needed" multiline />
      <RequestField label="Evidence" value={evidence} onChange={onEvidence} placeholder="Document, ticket or call notes reference" />
    </CommercialRequestDialog>
  );
}
