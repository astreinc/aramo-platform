import { Button } from '../../ui';

// CSP PA-7 (§11) — the shared publish action bar with an explicit change summary. No
// authoritative auto-save: the admin reviews the exact before→after deltas, then Publish
// creates the next immutable version. Publish is disabled until there is a change.
export function PublishBar({
  changes,
  publishing,
  onCancel,
  onPreview,
  onPublish,
}: {
  changes: readonly string[];
  publishing: boolean;
  onCancel: () => void;
  onPreview?: () => void;
  onPublish: () => void;
}): JSX.Element {
  return (
    <div className="rc-editor-foot">
      {changes.length > 0 ? (
        <div className="rc-change-summary">
          <span className="rc-change-summary__h">
            {changes.length} change{changes.length === 1 ? '' : 's'}
          </span>
          <ul className="rc-change-summary__list">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="rc-editor-bar">
        <span className="rc-editor-bar__count">
          {changes.length === 0 ? 'No changes yet' : 'Review the changes above, then publish.'}
        </span>
        {onPreview !== undefined ? (
          <Button variant="secondary" onClick={onPreview} disabled={publishing}>
            Preview effective policy
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onCancel} disabled={publishing}>
          Cancel
        </Button>
        <Button onClick={onPublish} disabled={publishing || changes.length === 0}>
          Publish changes
        </Button>
      </div>
    </div>
  );
}
