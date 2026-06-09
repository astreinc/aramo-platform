import * as RadixPopover from '@radix-ui/react-popover';
import { useState } from 'react';
import { Button, InlineAlert } from '@aramo/fe-foundation';

import { legalNextStates } from './legal-transitions';
import { ENGAGEMENT_STATE_LABELS, type EngagementState } from './types';

interface EngagementTransitionControlProps {
  readonly from: EngagementState;
  readonly disabled?: boolean;
  readonly onSubmit: (to: EngagementState) => Promise<void>;
}

// The Loops 1-5 transition control — a LOCAL clone of pipeline's MoveToMenu
// (fe-foundation is FROZEN; promote-on-2nd-consumer). Renders ONLY
// legalNextStates(from) so the recruiter can't pick an illegal target; the
// BE state machine is the source of truth, the FE matrix mirror is the
// affordance. Unlike pipeline's MoveToMenu there is NO note field — the
// engagement transition body is { to_state, event_id } only.
//
// A11y: trigger is role=button; the panel sets role=menu (Radix Popover
// handles outside-click + escape + focus return).
export function EngagementTransitionControl({
  from,
  disabled,
  onSubmit,
}: EngagementTransitionControlProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EngagementState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = legalNextStates(from);

  const close = () => {
    setOpen(false);
    setSelected(null);
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    if (selected === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(selected);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setSubmitting(false);
    }
  };

  if (targets.length === 0) {
    return (
      <span
        className="engagement-transition__terminal"
        aria-label="Terminal state — no further moves"
      >
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
          aria-label="Move engagement to a new state"
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
                    {ENGAGEMENT_STATE_LABELS[target]}
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
                Move to <strong>{ENGAGEMENT_STATE_LABELS[selected]}</strong>?
              </p>
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
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={submitting}
                >
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
