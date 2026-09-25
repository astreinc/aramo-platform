import { useState } from 'react';

import { Button } from '../../ui';

// CSP PA-7 (§11) — the shared publish surface: a sticky action bar (change label +
// Preview + Cancel + Publish) plus an explicit confirmation modal carrying the exact
// before→after deltas. No authoritative auto-save: Publish creates the next immutable
// version only after the admin confirms. Publish is disabled until there is a change.
export function PublishBar({
  changes,
  publishing,
  title,
  nextVersion,
  onCancel,
  onPreview,
  onPublish,
}: {
  changes: readonly string[];
  publishing: boolean;
  title: string;
  nextVersion: string;
  onCancel: () => void;
  onPreview?: () => void;
  onPublish: () => void;
}): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const has = changes.length > 0;
  const chgLabel = has ? `${changes.length} change${changes.length === 1 ? '' : 's'} to publish` : 'No changes yet';

  return (
    <>
      <div className="rc-pubbar">
        <span className={`rc-pubbar__chg${has ? ' rc-pubbar__chg--on' : ''}`}>{chgLabel}</span>
        {onPreview !== undefined ? (
          <Button unstyled className="rc-pubbar__preview" onClick={onPreview} disabled={publishing}>
            Preview effective policy
          </Button>
        ) : null}
        <span className="rc-pubbar__right">
          <Button unstyled className="rc-btn-ghost" onClick={onCancel} disabled={publishing}>
            Cancel
          </Button>
          <Button unstyled className="rc-btn-primary" onClick={() => setConfirmOpen(true)} disabled={publishing || !has}>
            Publish changes
          </Button>
        </span>
      </div>

      {confirmOpen ? (
        <>
          <div className="rc-modal__scrim" onClick={() => setConfirmOpen(false)} />
          <div className="rc-modal" role="dialog" aria-modal="true" aria-label={`Publish ${title}`}>
            <div className="rc-modal__head">
              <div className="rc-modal__title">Publish {title}?</div>
              <div className="rc-muted-line">Technology Ventures · becomes version {nextVersion}</div>
            </div>
            <div className="rc-modal__body">
              <div className="rc-modal__label">{chgLabel}</div>
              {changes.map((c) => (
                <div key={c} className="rc-modal__chg">
                  <span className="rc-modal__mark">~</span>
                  <span>{c}</span>
                </div>
              ))}
              <div className="rc-modal__note">
                <b>Effective immediately.</b>
                <span>
                  Applies to new submittals, communication evidence and Pre-Start checklists for this client. Items already in
                  progress keep the version they started under.
                </span>
              </div>
            </div>
            <div className="rc-modal__foot">
              <Button unstyled className="rc-btn-ghost" onClick={() => setConfirmOpen(false)} disabled={publishing}>
                Cancel
              </Button>
              <Button
                unstyled
                className="rc-btn-primary"
                onClick={() => {
                  setConfirmOpen(false);
                  onPublish();
                }}
                disabled={publishing}
              >
                Publish
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
