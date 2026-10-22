import { OWNER_ONLY_HINT, OWNER_ROLE_KEY, type RoleGroup } from './role-groups';

import './org-people.css';

// ORG-UX-1 (handoff §6.4 "Edit access", §6.3 Invite user) — the role checkbox groups: one
// group per subscribed app plus Organization; a title (13/700) with a grey truncated note;
// a bordered list of checkbox rows (18px box, label 13.5/600, description 12px; a checked
// row is #F5F7FE). H4: the Tenant Owner row is disabled for a non-owner with the hint
// "Only an owner can change owners."
export function RoleGroupsPicker({
  groups,
  selected,
  onChange,
  callerIsOwner,
}: {
  readonly groups: readonly RoleGroup[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly callerIsOwner: boolean;
}) {
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  return (
    <>
      {groups.map((g) => (
        <div key={g.key} data-testid={`role-group-${g.key}`}>
          <div className="oxp-group__head">
            <span className="oxp-group__title">{g.title}</span>
            <span className="oxp-group__note">{g.note}</span>
          </div>
          <div className="oxp-group__list" role="group" aria-label={g.title}>
            {g.roles.map((r) => {
              const on = selected.includes(r.key);
              const locked = r.key === OWNER_ROLE_KEY && !callerIsOwner;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={r.display}
                  className="oxp-rolerow"
                  disabled={locked}
                  title={locked ? OWNER_ONLY_HINT : undefined}
                  data-testid={`role-${r.key}`}
                  onClick={() => toggle(r.key)}
                >
                  <span className="oxp-rolerow__box" aria-hidden="true">
                    {on ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="oxp-rolerow__text">
                    <span className="oxp-rolerow__label">{r.display}</span>
                    {r.description.length > 0 ? <span className="oxp-rolerow__desc">{r.description}</span> : null}
                    {locked ? <span className="oxp-rolerow__hint">{OWNER_ONLY_HINT}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
