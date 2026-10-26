import './finance-components.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.8, §13.10) — a provider capability that is designed but not
// enabled (C5 Stripe Tax): the dashed box (#C3CBD2 on #FAFBFC) with a bold title and its reason.
// Never a calculation UI.

export interface NotEnabledStateProps {
  readonly title: string;
  readonly reason: string;
}

/** The C5 copy (Renewals, Revenue; the Tenant › Commercial facts row uses its short form). */
export const TAX_NOT_ENABLED = {
  title: 'Tax not enabled — pending Stripe Tax registration.',
  reason: 'Prices are shown before tax. Nothing is calculated or collected for tax.',
} as const;

export function NotEnabledState({ title, reason }: NotEnabledStateProps) {
  return (
    <div className="pw-notenabled" data-testid="not-enabled">
      <b>{title}</b>
      <span>{reason}</span>
    </div>
  );
}
