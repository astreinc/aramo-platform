import './platform-components.css';
import './ccp-components.css';

// CCP-B1 — the three-column before → after variant of DiffView (CCP-UI v1.0 handoff
// §5.2 item 4, §6 "DiffView … three-column before/after variant"): field, before
// struck through on the danger tint, after on the success tint at 600. Colour is
// never the only cue (handoff §9): the before value is struck and both carry
// hidden "Before:" / "After:" text. A before value the request does not carry is
// the designed empty value "—" (PLATFORM-UX-1 R-13), not struck.

export interface BeforeAfterRow {
  readonly key: string;
  readonly field: string;
  /** null = not recorded on the request (renders "—"). */
  readonly before: string | null;
  readonly after: string;
}

export interface BeforeAfterDiffProps {
  readonly rows: readonly BeforeAfterRow[];
  /** The list's accessible name. Default: "Effect, before and after". */
  readonly label?: string;
}

export function BeforeAfterDiff({ rows, label = 'Effect, before and after' }: BeforeAfterDiffProps) {
  return (
    <ul className="pw-badiff" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="pw-badiff__row">
          <span className="pw-badiff__field">{r.field}</span>
          {r.before === null ? (
            <span className="pw-badiff__none">
              <span className="pw-sr-only">Before: not recorded on the request </span>
              <span aria-hidden="true">—</span>
            </span>
          ) : (
            <span className="pw-badiff__before">
              <span className="pw-sr-only">Before: </span>
              {r.before}
            </span>
          )}
          <span className="pw-badiff__after">
            <span className="pw-sr-only">After: </span>
            {r.after}
          </span>
        </li>
      ))}
    </ul>
  );
}
