import { Button } from '@aramo/fe-foundation';

import type { TalentView } from './useTalentViewPreference';

// The ONE List|Board view toggle for the requisition's talent surface — the
// single visual implementation shared verbatim by the Talent tab and the
// Workspace → Talent in play, driven by the shared persisted preference
// (useTalentViewPreference; default Board). Pixel-matched to the approved
// prototype (Requisition Detail CRM › Talent in play): an #EEF1F4 track with two
// pill options, each a 13×13 line icon + label, the active option raised white
// with the brand ink. It owns NO state — value + onChange come from the lifted
// preference so switching in either surface agrees.

// 13×13 line icons (prototype paths). Stroked, currentColor — they inherit the
// option's active/inactive colour.
const ICON: Record<TalentView, string> = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  board: 'M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z',
};

const OPTIONS: ReadonlyArray<{ key: TalentView; label: string }> = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
];

export function TalentViewToggle({
  value,
  onChange,
  className,
}: {
  readonly value: TalentView;
  readonly onChange: (next: TalentView) => void;
  /** Optional placement class (e.g. spacing in the Talent tab). */
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      className={`rc-vtog${className !== undefined ? ` ${className}` : ''}`}
      role="tablist"
      aria-label="Talent view"
    >
      {OPTIONS.map(({ key, label }) => (
        <Button
          key={key}
          unstyled
          type="button"
          role="tab"
          aria-selected={value === key}
          className={`rc-vtog__opt${value === key ? ' rc-vtog__opt--on' : ''}`}
          onClick={() => onChange(key)}
        >
          <svg
            className="rc-vtog__ic"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={ICON[key]} />
          </svg>
          {label}
        </Button>
      ))}
    </span>
  );
}
