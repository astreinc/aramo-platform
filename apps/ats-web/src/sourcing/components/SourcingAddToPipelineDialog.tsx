import { useEffect, useState } from 'react';
import { Button, Dialog, InlineAlert } from '@aramo/fe-foundation';

import { listRequisitions } from '../../requisitions/requisitions-api';
import { isClosedStatus, type RequisitionView } from '../../requisitions/types';
import { Icons } from '../../ui';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The chosen requisition — the drawer runs the promote + maps the result. */
  readonly onPick: (requisitionId: string) => void;
  /** True while the parent's addToPipeline is in flight. */
  readonly busy: boolean;
}

// The Add-to-pipeline requisition picker. Lists the recruiter's visible OPEN
// requisitions (closed ones are excluded — you can't add to a closed pipeline),
// filters by title client-side, and hands the chosen id back to the drawer,
// which owns the promote call + the SourcingResult mapping (so deferrals render
// as guidance in one place).
export function SourcingAddToPipelineDialog({ open, onClose, onPick, busy }: Props) {
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listRequisitions()
      .then((res) => {
        if (!cancelled) setReqs(res.items);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your requisitions. Try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const options = reqs
    .filter((r) => !isClosedStatus(r.status))
    .filter((r) => (q === '' ? true : r.title.toLowerCase().includes(q)))
    .slice(0, 25);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          setError(null);
          onClose();
        }
      }}
      title="Add to pipeline"
      description="Promote this subject and add them to a requisition's pipeline."
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      }
    >
      <label className="rc-field">
        <span className="rc-field__label">Search requisitions</span>
        <input
          className="rc-select"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a title…"
          autoFocus
        />
      </label>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {loading ? (
        <p className="rc-empty">Loading requisitions…</p>
      ) : options.length === 0 ? (
        <p className="rc-empty">
          {reqs.length === 0
            ? 'No open requisitions visible to you.'
            : 'No open requisitions match that title.'}
        </p>
      ) : (
        <ul className="rc-pick">
          {options.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="rc-pick__row"
                onClick={() => onPick(r.id)}
                disabled={busy}
              >
                <span className="rc-pick__nm">{r.title}</span>
                {busy ? (
                  <span className="rc-pick__busy">Adding…</span>
                ) : (
                  <Icons.IconPlus />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
