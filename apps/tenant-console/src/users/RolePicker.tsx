import { TENANT_ASSIGNABLE_ROLES, type TenantRoleCatalogEntry } from './types';
import type { FinancialsToggleState } from './users-api';

// Settings S5b — the shared role-picker.
//
// Used by InviteDialog and RoleAssignEditor. A multi-select checkbox
// list over the 13 tenant-tier roles from TENANT_ASSIGNABLE_ROLES
// (the catalog mirror — PL-94 §2 ruling 2 hand-mirror + ruling 5
// catalog-faithful).
//
// Ruling 4 — THE S4 GATE reflected:
//   `auditor_with_financials` is proactively disabled in the picker
//   UNLESS the tenant's `audit.financials_enabled` setting is true.
//   The toggle state comes from the courtesy probe; on 403 (a pure
//   user-manage admin without tenant:admin:settings) the probe returns
//   { state: 'unknown' } and the option stays enabled — the BE
//   rejection is the floor. The picker never blocks on the read.
//
// The picker is uncontrolled-via-prop: parent owns the selected set;
// onToggle hands back the key and the next state. Sorted-on-write
// happens at the consumer (InviteDialog / RoleAssignEditor sort the
// payload before calling the API).

interface RolePickerProps {
  selectedKeys: ReadonlySet<string>;
  onToggle: (key: string, nextSelected: boolean) => void;
  disabled?: boolean;
  // Settings S4 — the courtesy probe outcome. When 'known' + enabled=false,
  // auditor_with_financials is proactively disabled with a helper message.
  // When 'unknown' (403), all options stay enabled and the BE rejection
  // is the floor.
  financialsToggle: FinancialsToggleState;
}

interface RowDecoration {
  disabled: boolean;
  helper?: string;
}

function decorateRow(
  entry: TenantRoleCatalogEntry,
  financialsToggle: FinancialsToggleState,
  globalDisabled: boolean,
): RowDecoration {
  if (globalDisabled) {
    return { disabled: true, helper: entry.helper };
  }
  if (
    entry.requiresSetting?.key === 'audit.financials_enabled' &&
    financialsToggle.state === 'known' &&
    financialsToggle.enabled === false
  ) {
    return {
      disabled: true,
      helper: entry.requiresSetting.disabledMessage,
    };
  }
  return { disabled: false, helper: entry.helper };
}

export function RolePicker({
  selectedKeys,
  onToggle,
  disabled = false,
  financialsToggle,
}: RolePickerProps) {
  return (
    <div
      className="tc-role-picker"
      role="group"
      aria-label="Assignable tenant roles"
    >
      {TENANT_ASSIGNABLE_ROLES.map((entry) => {
        const checked = selectedKeys.has(entry.key);
        const deco = decorateRow(entry, financialsToggle, disabled);
        const inputId = `role-picker-${entry.key}`;
        return (
          <label
            key={entry.key}
            className="tc-role-picker__row"
            htmlFor={inputId}
            data-disabled={deco.disabled ? 'true' : 'false'}
            data-role-key={entry.key}
          >
            <input
              id={inputId}
              type="checkbox"
              className="tc-role-picker__check"
              checked={checked}
              disabled={deco.disabled}
              aria-describedby={
                deco.helper !== undefined ? `${inputId}-helper` : undefined
              }
              onChange={(ev) => onToggle(entry.key, ev.target.checked)}
            />
            <span className="tc-role-picker__labels">
              <span className="tc-role-picker__label">{entry.label}</span>
              <span className="tc-role-picker__helper">
                {entry.description}
              </span>
              {deco.helper !== undefined && (
                <span
                  id={`${inputId}-helper`}
                  className="tc-role-picker__helper"
                >
                  {deco.helper}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
