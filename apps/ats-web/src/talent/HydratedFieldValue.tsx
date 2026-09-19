import {
  EMPTY_DISPLAY,
  toHydrationDisplay,
  type HydrationSourceType,
  type HydrationValue,
  type ProfileHydrationItem,
} from './profile-hydration';

// TALENT-INTEL-1 TI-1E-B1 — renders a single governed field's server hydration
// state on the READ surfaces. It consumes the projection; it never infers
// value_state or provenance. When `item` is absent (field not governed, or
// hydration not yet loaded) it falls back to the plain operational value.
export interface HydratedFieldValueProps {
  readonly item: ProfileHydrationItem | undefined;
  // Plain value shown when there is no hydration item (non-governed field or
  // pre-load); defaults to the em-dash.
  readonly fallback?: string;
  // Optional display formatter for enum fields whose raw value maps to a human
  // label (e.g. work_authorization → WORK_AUTHORIZATION_LABELS). Applied only to
  // a SET value; the em-dash + affordances are unaffected.
  readonly formatValue?: (v: HydrationValue) => string;
}

// The recruiter-facing provenance chip label — driven verbatim by the server
// source_type, never a client-inferred origin.
const SOURCE_LABEL: Record<HydrationSourceType, string> = {
  MANUAL: 'Manual',
  RESUME: 'Résumé',
  RECONCILED: 'Reconciled',
  IMPORT: 'Import',
};

export function HydratedFieldValue({
  item,
  fallback,
  formatValue,
}: HydratedFieldValueProps): JSX.Element {
  if (item === undefined) {
    return (
      <span className="hyd" data-testid="hydrated-value">
        {fallback !== undefined && fallback !== '' ? fallback : EMPTY_DISPLAY}
      </span>
    );
  }

  const d = toHydrationDisplay(item);
  const valueText =
    d.state === 'SET' && formatValue !== undefined
      ? formatValue(item.current_value)
      : d.valueText;

  return (
    <span className="hyd">
      <span className="hyd__val" data-testid="hydrated-value">
        {valueText}
      </span>
      {d.clearedLabel !== null ? (
        <span className="hyd__tag hyd__tag--cleared" data-testid="hydrated-cleared">
          {d.clearedLabel}
        </span>
      ) : null}
      {d.provenance !== null ? (
        <span
          className="hyd__tag hyd__tag--prov"
          data-testid="hydrated-provenance"
          title={`Source: ${SOURCE_LABEL[d.provenance]}`}
        >
          {SOURCE_LABEL[d.provenance]}
        </span>
      ) : null}
      {d.needsReview ? (
        <span
          className="hyd__tag hyd__tag--review"
          data-testid="hydrated-review"
          title={d.proposedText !== null ? `Proposed: ${d.proposedText}` : undefined}
        >
          {d.reviewLabel}
          {d.proposedText !== null ? ` · ${d.proposedText}` : ''}
        </span>
      ) : null}
    </span>
  );
}
