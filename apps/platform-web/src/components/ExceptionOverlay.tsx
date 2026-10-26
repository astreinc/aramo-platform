import './support-components.css';

// CCP-B6 (CCP-UI v1.0 handoff §5.9 "Exception overlay", §6 `ExceptionOverlay` NEW) — the overlay
// card of a support extension on a tenant's product: a 1.5px terracotta border and a #FBE7DF
// header "EXCEPTION · +n day support extension · applied with zero approvals · EXT-id", then the
// recorded context rows. An extension that Finance approved (not an exception: DDR v1.2 §3.2(5)
// flags only bounded zero-approval acts) keeps the card without the EXCEPTION tag and with a
// neutral frame. Colour is never the only cue: the EXCEPTION text tag carries it (§9).
// Local to platform-web (directive R-3).

export interface ExceptionOverlayRow {
  readonly label: string;
  readonly value: string;
}

export interface ExceptionOverlayProps {
  /** True for a bounded zero-approval exception; false for an approved extension. */
  readonly exception: boolean;
  /** "+10 day support extension · applied with zero approvals". */
  readonly title: string;
  /** "EXT-0042" (mono, right-aligned). */
  readonly reference: string;
  readonly rows: readonly ExceptionOverlayRow[];
}

export function ExceptionOverlay({ exception, title, reference, rows }: ExceptionOverlayProps) {
  return (
    <section className={`pw-xo${exception ? '' : ' pw-xo--approved'}`} aria-label={`${exception ? 'Exception: ' : ''}${title}`}>
      <div className="pw-xo__head">
        {exception ? <span className="pw-xo__tag">EXCEPTION</span> : null}
        <b>{title}</b>
        <span className="pw-xo__ref">{reference}</span>
      </div>
      <dl className="pw-xo__rows">
        {rows.map((r) => (
          <div key={r.label} className="pw-xo__row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
