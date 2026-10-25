import './commercial-components.css';

// CCP-B2 (CCP handoff §5.10, §6 `ChainPreview` NEW) — the chain preview strip in a commercial
// request dialog: "Approval chain · {label} · Finance → Owner · policy vN · 72 h window", with
// "· not fulfillable yet" while the chain cannot be filled (CCP-A9 bootstrap gate). Local to
// platform-web (directive R-3).

export interface ChainPreviewProps {
  /** "Catalog publish". */
  readonly label: string;
  /** The step names in order ("Finance", "Owner"). */
  readonly steps: readonly string[];
  /** "v1". */
  readonly policy: string;
  /** "72 h". */
  readonly window: string;
  readonly notFulfillable?: boolean;
}

export function ChainPreview({ label, steps, policy, window, notFulfillable = false }: ChainPreviewProps) {
  return (
    <div className="pw-chain" data-testid="chain-preview">
      <span className="pw-chain__lead">Approval chain</span>
      <b>{label}</b>
      <span className="pw-chain__steps">{`${steps.join(' → ')}${notFulfillable ? ' · not fulfillable yet' : ''}`}</span>
      <span className="pw-chain__meta">{`policy ${policy} · ${window} window`}</span>
    </div>
  );
}
