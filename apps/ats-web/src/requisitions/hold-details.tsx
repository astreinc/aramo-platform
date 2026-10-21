import type { RequisitionHold } from './types';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.4 (S3, A1 AM-3 §4) — the On hold
// banner, shown in the requisition detail header and above the Talent Board. Values are never
// invented: a hold placed before the amendment reads "not recorded"; a VMS hold with no
// provider reason reads "Reason not provided by VMS" (plus the provider status when known).
export const HOLD_NOT_RECORDED = 'not recorded';
export const HOLD_REASON_NOT_PROVIDED_BY_VMS = 'Reason not provided by VMS';
export const HOLD_RECRUITING_CONTINUES =
  'Recruiting and qualification may continue. Client submittals are unavailable until this requisition returns to Open.';

const SOURCE_LABEL: Record<'client' | 'vms' | 'internal', string> = {
  client: 'Client',
  vms: 'VMS',
  internal: 'Internal',
};

export interface HoldPresentation {
  readonly reasonLine: string;
  readonly sourceLabel: string | null;
  readonly effectiveLabel: string | null;
  readonly instructions: string | null;
}

export function presentHold(hold: RequisitionHold | null | undefined): HoldPresentation {
  if (hold === null || hold === undefined || !hold.recorded) {
    return { reasonLine: `Hold details ${HOLD_NOT_RECORDED}`, sourceLabel: null, effectiveLabel: null, instructions: null };
  }
  let reasonLine: string;
  if (hold.reason_provided && hold.reason !== null) {
    reasonLine = hold.reason;
  } else if (hold.source === 'vms') {
    reasonLine =
      hold.provider_status !== null
        ? `${HOLD_REASON_NOT_PROVIDED_BY_VMS} (VMS status: ${hold.provider_status})`
        : HOLD_REASON_NOT_PROVIDED_BY_VMS;
  } else {
    reasonLine = `Reason ${HOLD_NOT_RECORDED}`;
  }
  const effectiveLabel =
    hold.effective_at !== null ? new Date(hold.effective_at).toLocaleDateString() : null;
  return {
    reasonLine,
    sourceLabel: hold.source !== null ? SOURCE_LABEL[hold.source] : null,
    effectiveLabel,
    instructions: hold.instructions,
  };
}

export function RequisitionHoldBanner({
  hold,
}: {
  readonly hold: RequisitionHold | null | undefined;
}): JSX.Element {
  const p = presentHold(hold);
  return (
    <div className="rc-hold-banner" role="status" data-testid="requisition-hold-banner">
      <p className="rc-hold-banner__title">
        <b>On hold</b> — {p.reasonLine}
      </p>
      <p className="rc-hold-banner__meta">
        {p.sourceLabel !== null ? <span>Source: {p.sourceLabel}</span> : null}
        {p.effectiveLabel !== null ? <span> · Since {p.effectiveLabel}</span> : null}
      </p>
      {p.instructions !== null ? (
        <p className="rc-hold-banner__instructions">Account Manager instructions: {p.instructions}</p>
      ) : null}
      <p className="rc-hold-banner__note">{HOLD_RECRUITING_CONTINUES}</p>
    </div>
  );
}
