import { useEffect, useState } from 'react';
import { Dialog } from '@aramo/fe-foundation';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FieldText, FieldTextArea } from '../../components/ConfirmFields';
import { formatDate } from '../../components/format-date';
import { useReturnFocus } from '../../components/use-return-focus';
import { DEFAULT_WITHDRAW_NOTICE_DAYS, MAX_WITHDRAW_NOTICE_DAYS } from '../document-templates-api';

import type { DiffStats } from './diff';

// PLATFORM-UX-1 F-9 (handoff §10.7) — the Studio's confirm dialogs, on the platform
// ConfirmDialog (from → to Change box, consequence, fields, error; focus trap, Esc,
// focus return): Publish vN, Withdraw, Cancel withdrawal, Restore into draft — and the
// keyboard shortcuts sheet (§10.8).

export interface PublishDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly name: string;
  readonly next: number;
  readonly current: number | null;
  readonly stats: DiffStats;
  readonly variables: number;
  readonly warnings: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onPublish: () => void;
}

export function publishConsequence(next: number, current: number | null): string {
  return `v${next} becomes the platform default for every tenant that uses this template. Documents already sent are not changed.${
    current !== null ? ` v${current} is marked Replaced and stays viewable.` : ''
  }`;
}

export function PublishDialog(p: PublishDialogProps) {
  const tiles: ReadonlyArray<[string, number]> = [
    ['Added', p.stats.added],
    ['Changed', p.stats.changed],
    ['Removed', p.stats.removed],
    ['Variables', p.variables],
  ];
  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={`Publish v${p.next} of ${p.name}`}
      from={p.current !== null ? { label: `v${p.current} published`, tone: 'ok' } : { label: 'Not published', tone: 'neutral' }}
      to={{ label: `v${p.next} published`, tone: 'ok' }}
      consequence={publishConsequence(p.next, p.current)}
      tone="privileged"
      commitLabel={`Publish v${p.next}`}
      busy={p.busy}
      error={p.error}
      onCommit={p.onPublish}
    >
      <div className="pws-tiles">
        {tiles.map(([l, c]) => (
          <div key={l} className="pws-tile">
            <div className="pws-tile__c">{c}</div>
            <div className="pws-tile__l">{l}</div>
          </div>
        ))}
      </div>
      {p.warnings > 0 ? (
        <div className="pw-alert pw-alert--warn pws-dlg-warn">
          {p.warnings} warning{p.warnings > 1 ? 's' : ''} (inactive variables) will publish as is.
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/** Notice days valid: a whole number 0–365. */
export function noticeDaysValid(raw: string): boolean {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_WITHDRAW_NOTICE_DAYS;
}

/** The effective date line under the withdraw fields. */
export function effectiveLine(raw: string, now: Date = new Date()): string {
  if (!noticeDaysValid(raw)) return `Enter 0–${MAX_WITHDRAW_NOTICE_DAYS} days.`;
  const d = Number(raw);
  return `Takes effect ${formatDate(new Date(now.getTime() + d * 86_400_000))}${d === 0 ? ' (immediately)' : ''}`;
}

export interface WithdrawDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly name: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onWithdraw: (days: number, reason: string) => void;
}

export function WithdrawDialog(p: WithdrawDialogProps) {
  const [days, setDays] = useState(String(DEFAULT_WITHDRAW_NOTICE_DAYS));
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (p.open) {
      setDays(String(DEFAULT_WITHDRAW_NOTICE_DAYS));
      setReason('');
    }
  }, [p.open]);
  const ok = noticeDaysValid(days) && reason.trim() !== '';
  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={`Withdraw ${p.name}`}
      consequence="Tenants are told this default is being withdrawn. After the notice period it can’t be used for new documents. Documents already sent are unaffected."
      tone="privileged"
      commitLabel="Withdraw template"
      canCommit={ok}
      busy={p.busy}
      error={p.error}
      onCommit={() => p.onWithdraw(Number(days), reason.trim())}
    >
      <FieldText label="Notice period (days)" required type="number" value={days} onChange={setDays} helper="0–365. 0 withdraws immediately." />
      <FieldTextArea label="Reason" required value={reason} onChange={setReason} max={500} helper="Shown to tenant admins with the notice." />
      <div className="pws-dlg-live" aria-live="polite">
        {effectiveLine(days)}
      </div>
    </ConfirmDialog>
  );
}

export interface SimpleConfirmProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
}

export function CancelWithdrawalDialog(p: SimpleConfirmProps) {
  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title="Cancel withdrawal"
      consequence="The template stays available to tenants. Tenant admins are told the withdrawal was cancelled."
      commitLabel="Cancel withdrawal"
      busy={p.busy}
      error={p.error}
      onCommit={p.onConfirm}
    />
  );
}

export function RestoreDialog(p: SimpleConfirmProps & { readonly version: number }) {
  return (
    <ConfirmDialog
      open={p.open}
      onOpenChange={p.onOpenChange}
      title={`Restore v${p.version} into the draft`}
      consequence={`Replaces the current draft content with v${p.version}. Published versions are not changed. You can still compare or undo by restoring another version.`}
      commitLabel="Replace draft"
      onCommit={p.onConfirm}
    />
  );
}

export const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['⌘ S', 'Save draft'],
  ['⌘ ⇧ P', 'Toggle preview'],
  ['⌘ B / I / U', 'Bold, italic, underline'],
  ['/', 'Block menu on an empty line'],
  ['{{', 'Insert a variable'],
  ['Enter', 'New paragraph'],
  ['⌥ ↑ / ⌥ ↓', 'Move block up or down'],
  ['Backspace', 'Delete an empty block'],
  ['⌘ Z / ⌘ ⇧ Z', 'Undo / redo'],
  ['⌘ \\', 'Collapse or expand the sidebar'],
  ['?', 'This sheet'],
  ['Esc', 'Close menus and dialogs'],
];

export function ShortcutsSheet({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  useReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      <div className="pws-keys">
        {SHORTCUTS.map(([k, l]) => (
          <span key={k} className="pws-keys__row">
            <span className="pws-keys__k">{k}</span>
            <span>{l}</span>
          </span>
        ))}
      </div>
    </Dialog>
  );
}
