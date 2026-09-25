import { useState } from 'react';

import { Button } from '../../ui';

// CSP PA-7 (§12/§13) — the prototype "+ Add requirement" affordance. The catalog is the
// closed, Aramo-verifiable requirement set for the domain (never a generic rule builder,
// §37). Every canonical requirement is already rendered as a row in these editors, so the
// catalog is normally empty — the button then explains that rather than opening a dead
// popover.
export interface CatalogEntry {
  readonly label: string;
  readonly desc: string;
  readonly onAdd: () => void;
}

export function AddRequirementButton({
  catalog,
  emptyText = 'Every requirement Aramo can verify today is already shown for this client.',
}: {
  catalog: readonly CatalogEntry[];
  emptyText?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rc-addreq">
      <Button unstyled className="rc-addreq__btn" onClick={() => setOpen((o) => !o)}>
        + Add requirement
      </Button>
      {open ? (
        <>
          <div className="rc-addreq__scrim" onClick={() => setOpen(false)} />
          <div className="rc-addreq__pop">
            <div className="rc-addreq__h">From the requirement catalog</div>
            {catalog.length === 0 ? (
              <div className="rc-addreq__empty">{emptyText}</div>
            ) : (
              catalog.map((c) => (
                <Button
                  key={c.label}
                  unstyled
                  className="rc-addreq__item"
                  onClick={() => {
                    c.onAdd();
                    setOpen(false);
                  }}
                >
                  {c.label}
                  <span>{c.desc}</span>
                </Button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
