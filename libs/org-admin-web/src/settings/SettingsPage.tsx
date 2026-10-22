import { OrgPageHeader } from '../ui/OrgPage';

// ORG-UX-1 (Directive v1.0 LOCKED §8.7, P4; handoff §6.7) — Settings → Regional defaults.
// There are no organization regional-default settings in the backend yet (G6, a
// documented data gap; a later directive adds the keys). The five selects render
// DISABLED and labelled "Coming soon", with no active Save — never a control that
// looks like it saves something.

export const REGIONAL_DEFAULT_FIELDS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'time_zone', label: 'Time zone' },
  { key: 'date_format', label: 'Date format' },
  { key: 'language', label: 'Language' },
  { key: 'currency', label: 'Currency' },
  { key: 'week_start', label: 'Week starts on' },
];

export function SettingsPage() {
  return (
    <>
      <OrgPageHeader section="settings" />
      <section className="ox-card" style={{ maxWidth: 820, overflow: 'hidden' }} aria-labelledby="st-regional-title" data-testid="settings-regional">
        <div className="ox-card__head">
          <div>
            <h2 id="st-regional-title" className="ox-card__title">
              Regional defaults <span className="ox-badge" style={{ marginLeft: 6, verticalAlign: 'middle' }}>Coming soon</span>
            </h2>
            <p className="ox-card__sub" style={{ lineHeight: 1.5 }}>
              New people and every Aramo app start with these. Each person can change their own in My preferences.
            </p>
          </div>
        </div>
        <div className="ox-form-grid" style={{ padding: '16px 20px 20px' }}>
          {REGIONAL_DEFAULT_FIELDS.map((f) => (
            <label className="ox-field" key={f.key} htmlFor={`st-${f.key}`}>
              <span className="ox-label">{f.label}</span>
              <select id={`st-${f.key}`} className="ox-select" disabled value="" aria-describedby="st-coming-soon" data-testid={`settings-field-${f.key}`}>
                <option value="">Coming soon</option>
              </select>
            </label>
          ))}
        </div>
        <div className="ox-card__foot" style={{ padding: '12px 20px 16px' }}>
          <span id="st-coming-soon" className="ox-hint" style={{ flex: 1 }}>
            Coming soon — organization regional defaults aren’t available yet.
          </span>
          <button type="button" className="ox-btn ox-btn--primary" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }} data-testid="settings-save">
            Save changes
          </button>
        </div>
      </section>
    </>
  );
}
