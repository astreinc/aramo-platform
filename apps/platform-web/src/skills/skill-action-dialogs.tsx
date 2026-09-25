import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Combobox,
  Dialog,
  FormField,
  InlineAlert,
  type ComboboxItem, Checkbox, Input, TextArea,
} from '@aramo/fe-foundation';

import { skillsApi, type Skill } from './skills-api';
import { skillErrorMessage } from './skill-errors';

// SKILL-TAX-1F-C1 — the high-impact governance action dialogs. Merge and override
// carry explicit typed confirmation; a generic ConfirmDialog gates deactivate /
// reactivate / soft-remove. None imply synchronous downstream rewriting — the
// durable correction is owned by the B1 propagation engine.

// ---- Generic confirm (deactivate / reactivate / soft-remove) --------------
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  requireAck,
  ackLabel,
  onConfirm,
  open,
  onOpenChange,
  onDone,
}: {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly requireAck?: boolean;
  readonly ackLabel?: string;
  readonly onConfirm: () => Promise<void>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(skillErrorMessage(e, 'Action failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || (requireAck === true && !ack)}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <div className="pw-notice" role="status">
        {body}
      </div>
      {requireAck ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{ackLabel ?? 'I understand.'}</span>
        </label>
      ) : null}
    </Dialog>
  );
}

// ---- Merge (typed confirmation of BOTH identities) ------------------------
export function MergeDialog({
  loser,
  open,
  onOpenChange,
  onDone,
}: {
  readonly loser: Skill;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: (result?: Skill) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    skillsApi
      .listSkills()
      .then((res) => live && setSkills(res.skills))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // A live merge target must be active + not itself already merged away (mirrors the
  // service's winner validation; server-side is authoritative).
  const items = useMemo<ComboboxItem[]>(
    () =>
      skills
        .filter((s) => s.id !== loser.id && s.status === 'active' && s.merged_into_skill_id === null)
        .map((s) => ({ value: s.id, label: s.canonical_name, description: s.normalized_name })),
    [skills, loser.id],
  );
  const winner = skills.find((s) => s.id === winnerId) ?? null;

  const submit = async (): Promise<void> => {
    if (winnerId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await skillsApi.mergeSkill(loser.id, { winner_skill_id: winnerId });
      onOpenChange(false);
      onDone(result);
    } catch (e) {
      setError(skillErrorMessage(e, 'Merge failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Merge skill"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || winnerId === null || !ack}>
            {busy ? 'Working…' : 'Merge'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Merge into (winner)">
        <Combobox
          items={items}
          value={winnerId}
          onSelect={(item) => setWinnerId(item.value)}
          placeholder="Choose the surviving skill…"
          emptyMessage="No eligible skills."
          ariaLabel="Winner skill"
        />
      </FormField>
      <p className="pw-notice" role="status">
        <strong>
          Merge “{loser.canonical_name}” into {winner ? `“${winner.canonical_name}”` : 'the selected skill'}.
        </strong>{' '}
        “{loser.canonical_name}” stays permanently identifiable in history but becomes
        <em> inactive</em> and points at the winner. Downstream references are corrected
        <em> asynchronously and durably</em> by the propagation engine — this does not rewrite
        every referencing row synchronously.
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand this merges “{loser.canonical_name}”
          {winner ? ` into “${winner.canonical_name}”` : ''}.
        </span>
      </label>
    </Dialog>
  );
}

// ---- Override (governed correction; not free-form) ------------------------
export function OverrideDialog({
  skill,
  open,
  onOpenChange,
  onDone,
}: {
  readonly skill: Skill;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const [surfaceForm, setSurfaceForm] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await skillsApi.overrideSkill(skill.id, {
        surface_form: surfaceForm.trim().length > 0 ? surfaceForm.trim() : null,
        reason: reason.trim(),
      });
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(skillErrorMessage(e, 'Override failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record canonicalization override"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || reason.trim().length === 0}>
            {busy ? 'Working…' : 'Record override'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <p className="pw-notice" role="status">
        Records a governed canonicalization correction against <strong>{skill.canonical_name}</strong>
        {' '}and enqueues a durable re-reconcile. This is a targeted correction — not a free-form edit.
      </p>
      <FormField label="Governed surface form (optional)" helper="Scope the correction to one surface, when applicable.">
        <Input unstyled className="tc-input" value={surfaceForm} onChange={(e) => setSurfaceForm(e.target.value)} />
      </FormField>
      <FormField label="Reason (required)">
        <TextArea unstyled className="tc-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Dialog>
  );
}
