import './finance-components.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.3, §13.10) — the Billing reconciliation header tile: the
// page's exception count, the ONLY total on that page.

export interface ExceptionCountTileProps {
  readonly count: number;
  /** Default: "Exceptions". */
  readonly label?: string;
}

export function ExceptionCountTile({ count, label = 'Exceptions' }: ExceptionCountTileProps) {
  return (
    <div className="pw-exctile" data-testid="exception-count">
      <div className="pw-exctile__label">{label}</div>
      <div className="pw-exctile__n">{count}</div>
    </div>
  );
}
