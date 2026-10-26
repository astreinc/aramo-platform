import './finance-components.css';

// CCP-UI-V12 (CCP-UI v1.2 handoff §17.4) — a tenant-specific monetary figure the server withheld
// from this caller (`amount_withheld: "FINANCE_SCOPE_REQUIRED"`, CCP-A1 Amendment A1 FA-5). It
// never takes an amount: the console has no figure to hide. "Withheld" with a lock glyph, muted
// tone (#5C6770 on #F4F6FA, 1px dashed #C3CBD2). Distinct from WithheldPrice (a list price the
// catalog cannot give, plain text with its reason).

export type WithheldAmountReason = 'FINANCE_SCOPE_REQUIRED';

export interface WithheldAmountProps {
  readonly reason: WithheldAmountReason;
  /** cell: 12px / 600, 6px radius (tables, inline); stat: 17px / 700, 8px radius (a tile). */
  readonly size: 'cell' | 'stat';
}

export const WITHHELD_TOOLTIP = 'Finance access required (amount-read)';
export const WITHHELD_ARIA = 'Amount withheld: finance access required';

export function WithheldAmount({ reason, size }: WithheldAmountProps) {
  const px = size === 'stat' ? 15 : 12;
  return (
    <span className={`pw-withheld pw-withheld--${size}`} title={WITHHELD_TOOLTIP} aria-label={WITHHELD_ARIA} role="img" data-reason={reason} data-testid="withheld-amount">
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      Withheld
    </span>
  );
}
