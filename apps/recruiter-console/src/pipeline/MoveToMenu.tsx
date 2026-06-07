import * as RadixPopover from '@radix-ui/react-popover';
import { useState } from 'react';
import { Button, FormField, InlineAlert } from '@aramo/fe-foundation';

import { legalNextStates } from './legal-transitions';
import {
  PIPELINE_STATUS_LABELS,
  type PipelineStatus,
} from './types';

interface MoveToMenuProps {
  readonly from: PipelineStatus;
  readonly disabled?: boolean;
  readonly onSubmit: (toStatus: PipelineStatus, note: string | undefined) => Promise<void>;
}

// Q5 ruling — the per-card "Move to…" Popover. Renders ONLY
// legalNextStates(from) so the recruiter can't pick an illegal target;
// the BE state machine is the source of truth, the FE matrix mirror is
// the affordance.
//
// A11y: trigger is role=button; the panel sets role=menu (Radix Popover
// handles outside-click + escape + focus return).
export function MoveToMenu({ from, disabled, onSubmit }: MoveToMenuProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PipelineStatus | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = legalNextStates(from);

  const close = () => {
    setOpen(false);
    setSelected(null);
    setNote('');
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    if (selected === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(selected, note.trim() === '' ? undefined : note.trim());
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setSubmitting(false);
    }
  };

  if (targets.length === 0) {
    return (
      <span className="kanban-card__terminal" aria-label="Terminal status — no further moves">
        Final
      </span>
    );
  }

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled}>
          Move to…
        </Button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="move-to-menu"
          align="start"
          sideOffset={6}
          aria-label="Move pipeline to a new status"
        >
          {selected === null ? (
            <ul className="move-to-menu__targets" role="menu">
              {targets.map((target) => (
                <li key={target} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="move-to-menu__target"
                    onClick={() => setSelected(target)}
                  >
                    {PIPELINE_STATUS_LABELS[target]}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="move-to-menu__confirm"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p>
                Move to <strong>{PIPELINE_STATUS_LABELS[selected]}</strong>?
              </p>
              <FormField label="Note (optional)">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  disabled={submitting}
                />
              </FormField>
              {error !== null ? (
                <InlineAlert variant="error">{error}</InlineAlert>
              ) : null}
              <div className="move-to-menu__actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelected(null)}
                  disabled={submitting}
                >
                  Back
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                  {submitting ? 'Moving…' : 'Confirm move'}
                </Button>
              </div>
            </form>
          )}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
