import { useEffect, useState } from 'react';
import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';

import { addTalentToPipeline } from '../pipeline/pipeline-api';
import { listTalent } from '../talent/talent-api';
import type { TalentRecordView } from '../talent/types';
import { Avatar, Icons } from '../ui';

interface AddTalentDialogProps {
  readonly requisitionId: string;
  /** Talent already on this pipeline — excluded from the picker. */
  readonly existingTalentIds: readonly string[];
  readonly onAdded: () => void;
}

// The mockup's primary header action. Opens a dialog that lists the tenant
// talent pool (POOL-OPEN, the R2 framing), filters by name client-side,
// excludes talent already on this pipeline, and adds the chosen one via
// POST /v1/pipelines (pipeline:add). The new row enters at the hard-coded
// initial status (no_contact) — the BE owns that.
export function AddTalentDialog({
  requisitionId,
  existingTalentIds,
  onAdded,
}: AddTalentDialogProps) {
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState<readonly TalentRecordView[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listTalent()
      .then((res) => {
        if (!cancelled) setPool(res.items);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the talent pool. Try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const existing = new Set(existingTalentIds);
  const q = query.trim().toLowerCase();
  const options = pool
    .filter((t) => !existing.has(t.id))
    .filter((t) =>
      q === '' ? true : `${t.first_name} ${t.last_name}`.toLowerCase().includes(q),
    )
    .slice(0, 25);

  const add = async (talentId: string) => {
    setBusyId(talentId);
    setError(null);
    try {
      await addTalentToPipeline(talentId, requisitionId);
      toast.show('Talent added to the pipeline.');
      setOpen(false);
      setQuery('');
      onAdded();
    } catch {
      setError('Could not add this talent. They may already be on the pipeline.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <button className="rc-hbtn rc-hbtn--primary" onClick={() => setOpen(true)}>
        <Icons.IconPlus />
        Add talent
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery('');
            setError(null);
          }
        }}
        title="Add talent"
        description="Add talent from your pool to this requisition's pipeline."
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <label className="rc-field">
          <span className="rc-field__label">Search talent</span>
          <input
            className="rc-select"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a name…"
            autoFocus
          />
        </label>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        {loading ? (
          <p className="rc-empty">Loading talent…</p>
        ) : options.length === 0 ? (
          <p className="rc-empty">
            {pool.length === 0
              ? 'No talent in your pool yet.'
              : 'No matching talent (or all matches are already on this pipeline).'}
          </p>
        ) : (
          <ul className="rc-pick">
            {options.map((t) => {
              const name = `${t.first_name} ${t.last_name}`.trim();
              return (
                <li key={t.id}>
                  <button
                    className="rc-pick__row"
                    onClick={() => void add(t.id)}
                    disabled={busyId !== null}
                  >
                    <Avatar name={name} size="sm" />
                    <span className="rc-pick__nm">{name}</span>
                    {t.key_skills != null && t.key_skills !== '' ? (
                      <span className="rc-pick__sub">{t.key_skills}</span>
                    ) : null}
                    {busyId === t.id ? (
                      <span className="rc-pick__busy">Adding…</span>
                    ) : (
                      <Icons.IconPlus />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}
