import { Pill } from './Pill';

// CCP-UI-V12 (CCP-UI v1.2 handoff §17.4; CCP-A1 Amendment A1 FAS-3 / FA-4) — the due status every
// billing reader may see. StatusPill tones muted / warn / danger, labelled "Not due" / "Due" /
// "Overdue" (the text is the non-colour cue). It never takes an amount.

export type PaymentDueState = 'NOT_DUE' | 'DUE' | 'OVERDUE';

export interface PaymentDueIndicatorProps {
  readonly state: PaymentDueState;
}

const SPEC: Readonly<Record<PaymentDueState, { label: string; tone: 'muted' | 'warn' | 'danger' }>> = {
  NOT_DUE: { label: 'Not due', tone: 'muted' },
  DUE: { label: 'Due', tone: 'warn' },
  OVERDUE: { label: 'Overdue', tone: 'danger' },
};

/** The state from the server's FA-4 booleans (`payment_overdue` wins over `payment_due`). */
export function paymentDueState(flags: { readonly payment_due?: boolean; readonly payment_overdue?: boolean }): PaymentDueState {
  if (flags.payment_overdue === true) return 'OVERDUE';
  if (flags.payment_due === true) return 'DUE';
  return 'NOT_DUE';
}

export function PaymentDueIndicator({ state }: PaymentDueIndicatorProps) {
  const s = SPEC[state];
  return (
    <span className="pw-paydue" data-state={state} data-testid="payment-due">
      <Pill tone={s.tone}>{s.label}</Pill>
    </span>
  );
}
