import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

import { Icons, StatusPill } from '../../ui';
import {
  OWNER_LABELS,
  PRIORITY_LABELS,
  PRIORITY_TONE,
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_LABELS,
  ownerHref,
  ownerIcon,
} from '../task-vocab';
import { dueShortLabel } from '../workspace';
import type { TaskView } from '../types';

// Tasks workspace — the right-hand detail drawer. Read view + the backed
// actions (Complete/Reopen, Reschedule, Edit). Reassign is DEFERRED (disabled).
// Source is shown honestly ('Created manually' / the reserved 'Aramo workflow').

interface TaskDrawerProps {
  readonly task: TaskView | null;
  readonly now: Date;
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onToggleDone: (task: TaskView) => void;
  readonly onReschedule: (task: TaskView) => void;
  readonly onEdit: (task: TaskView) => void;
}

export function TaskDrawer({
  task,
  now,
  canWrite,
  onClose,
  onToggleDone,
  onReschedule,
  onEdit,
}: TaskDrawerProps) {
  // T10-B3/F-037 — the Tasks drawer is modal (a scrim covers the page), so it
  // gets the same accessible pattern its sibling drawers already implement:
  // capture the trigger + move focus in on open (restore on close), Escape to
  // close, and a Tab focus-trap while open.
  const asideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const open = task !== null;

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    headingRef.current?.focus();
    const toRestore = restoreRef.current;
    return () => toRestore?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = asideRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (task === null) return null;
  const done = task.status === 'done' || task.status === 'cancelled';
  const href = ownerHref(task.owner_type, task.owner_id);

  return (
    <>
      <div className="rc-scrim rc-scrim--open" onClick={onClose} aria-hidden="true" />
      <aside
        ref={asideRef}
        className="rc-drawer rc-drawer--open"
        role="dialog"
        aria-modal="true"
        aria-label="Task detail"
        data-testid="task-drawer"
      >
        <div className="rc-drawer__hd">
          <h3 ref={headingRef} tabIndex={-1} className="rc-drawer__title">
            {task.title}
          </h3>
          <button type="button" className="rc-drawer__x" aria-label="Close" onClick={onClose}>
            <Icons.IconX />
          </button>
        </div>
        <div className="rc-drawer__body">
          <div className="rc-drawer__chips">
            <StatusPill tone={STATUS_TONE[task.status]} dot>
              {STATUS_LABELS[task.status]}
            </StatusPill>
            {task.priority !== null ? (
              <StatusPill tone={PRIORITY_TONE[task.priority]} dot>
                {PRIORITY_LABELS[task.priority]} priority
              </StatusPill>
            ) : null}
            <StatusPill tone="neutral">
              {task.source === 'auto' ? 'Aramo workflow' : 'Manual'}
            </StatusPill>
          </div>

          {task.description !== null && task.description !== '' ? (
            <p className="rc-drawer__desc">{task.description}</p>
          ) : null}

          <dl className="rc-drawer__kv">
            <dt>Type</dt>
            <dd>{task.type !== null ? TYPE_LABELS[task.type] : '—'}</dd>
            <dt>Status</dt>
            <dd>{STATUS_LABELS[task.status]}</dd>
            <dt>Due</dt>
            <dd>{dueShortLabel(task, now)}</dd>
            <dt>Linked to</dt>
            <dd>
              {href !== null ? (
                <Link className={`rc-tlink rc-tlink--${task.owner_type}`} to={href}>
                  {ownerIcon(task.owner_type)}
                  {OWNER_LABELS[task.owner_type]}
                </Link>
              ) : (
                <span className={`rc-tlink rc-tlink--${task.owner_type}`}>
                  {ownerIcon(task.owner_type)}
                  {OWNER_LABELS[task.owner_type]}
                </span>
              )}
            </dd>
            <dt>Source</dt>
            <dd>{task.source === 'auto' ? 'Aramo workflow' : 'Created manually'}</dd>
          </dl>
        </div>
        {canWrite ? (
          <div className="rc-drawer__foot">
            <button type="button" className="rc-btn rc-btn--primary" onClick={() => onToggleDone(task)} data-testid="drawer-complete">
              <Icons.IconCheck />
              {done ? 'Reopen' : 'Complete'}
            </button>
            <button type="button" className="rc-btn" onClick={() => onReschedule(task)} data-testid="drawer-reschedule">
              <Icons.IconClock />
              Reschedule
            </button>
            <button type="button" className="rc-btn" onClick={() => onEdit(task)} data-testid="drawer-edit">
              <Icons.IconPencil />
              Edit
            </button>
            <button type="button" className="rc-btn" disabled title="Reassign needs an assignable-users roster + assign scope (carry).">
              <Icons.IconUserPlus />
              Reassign
            </button>
          </div>
        ) : null}
      </aside>
    </>
  );
}
