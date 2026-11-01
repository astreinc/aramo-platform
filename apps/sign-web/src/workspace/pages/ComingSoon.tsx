import { COMING_SOON } from '../catalog';

// Aramo Sign Catalog v2 directive P-1 — features that are not built are listed as "Coming soon",
// visibly not part of any plan and not sold.
export function ComingSoon() {
  return (
    <section className="sg-card" data-testid="plans-coming-soon" aria-label="Coming soon">
      <div className="sg-card__head">
        Coming soon
        <span className="sg-card__end sg-tag sg-tag--grey">Not included in any plan yet</span>
      </div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginTop: 0 }}>
          These features are planned. They are not part of any plan and are not sold until they are released.
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, columns: 2 }}>
          {COMING_SOON.map((f) => (
            <li key={f} className="sg-muted">
              {f}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
