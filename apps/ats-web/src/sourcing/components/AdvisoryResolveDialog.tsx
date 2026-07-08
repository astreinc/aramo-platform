import { useState } from 'react';
import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';

import { approveAdvisory, dismissAdvisory } from '../sourcing-api';
import { advisoryErrorMessage } from '../error-messages';

export type AdvisoryAction = 'approve' | 'dismiss';

// The named-kind arrays the TR-6 worklist enriches an advisory with. Optional:
// the sourcing subject-drawer path does not carry them, so the dialog falls back
// to the generic sentence when they are absent.
export interface AdvisoryKinds {
  readonly shared_anchor_kinds: readonly string[];
  readonly confirmed_kinds: readonly string[];
  readonly contradiction_kinds: readonly string[];
  readonly corroborator_conflict_kinds: readonly string[];
}

// Minimal structural shape the dialog needs from EITHER caller: the sourcing
// SubjectAdvisory OR the identity-advisories worklist item. Only id +
// has_contradiction drive behaviour; `kinds` is the worklist enrichment.
export interface ResolvableAdvisory {
  readonly id: string;
  readonly has_contradiction: boolean;
  readonly kinds?: AdvisoryKinds;
}

interface Props {
  readonly advisory: ResolvableAdvisory | null;
  readonly action: AdvisoryAction;
  readonly onClose: () => void;
  /** Re-fetch the subject detail so the resolved advisory drops off the list. */
  readonly onResolved: () => void;
}

// Compose the compact named-kinds summary, e.g.
// "Shares EMAIL, PHONE · Contradicts PHONE · Name conflict". Returns null when
// no kinds are populated so the caller falls back to the generic sentence.
function kindsSummary(kinds: AdvisoryKinds | undefined): string | null {
  if (kinds === undefined) return null;
  const parts: string[] = [];
  if (kinds.shared_anchor_kinds.length > 0) {
    parts.push(`Shares ${kinds.shared_anchor_kinds.join(', ')}`);
  }
  if (kinds.confirmed_kinds.length > 0) {
    parts.push(`Confirmed ${kinds.confirmed_kinds.join(', ')}`);
  }
  if (kinds.contradiction_kinds.length > 0) {
    parts.push(`Contradicts ${kinds.contradiction_kinds.join(', ')}`);
  }
  if (kinds.corroborator_conflict_kinds.length > 0) {
    parts.push(`${kinds.corroborator_conflict_kinds.join(', ')} conflict`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Inline advisory resolution — approve (execute the pointer-only merge) or
// dismiss (not the same human), reusing the privileged /advisories POSTs
// (identity:resolve; the caller gates the trigger button). A CONTRADICTED
// advisory can only be approved with an explicit acknowledgement + justification
// (R3) — the ack checkbox + required reason appear only then. Uses the shared
// small confirm Dialog; success toasts past-tense, errors render inline.
export function AdvisoryResolveDialog({ advisory, action, onClose, onResolved }: Props) {
  const [justification, setJustification] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const contradicted = advisory?.has_contradiction ?? false;
  const summary = kindsSummary(advisory?.kinds);
  // R3: approving a contradicted advisory requires ack + a justification.
  const overrideRequired = action === 'approve' && contradicted;
  const justificationOk = !overrideRequired || justification.trim().length > 0;
  const ackOk = !overrideRequired || ack;
  const canSubmit = advisory !== null && !busy && justificationOk && ackOk;

  const reset = () => {
    setJustification('');
    setAck(false);
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (advisory === null) return;
    setBusy(true);
    setError(null);
    const reason = justification.trim();
    try {
      if (action === 'approve') {
        await approveAdvisory(advisory.id, {
          ...(reason.length > 0 ? { justification: reason } : {}),
          ...(overrideRequired ? { override_acknowledged: true } : {}),
        });
        toast.show('Identity merge approved.');
      } else {
        await dismissAdvisory(advisory.id, {
          ...(reason.length > 0 ? { justification: reason } : {}),
        });
        toast.show('Advisory dismissed.');
      }
      reset();
      onResolved();
      onClose();
    } catch (err) {
      setError(advisoryErrorMessage(err));
      setBusy(false);
    }
  };

  const title = action === 'approve' ? 'Approve this identity merge?' : 'Dismiss this advisory?';
  const confirmLabel =
    action === 'approve'
      ? busy
        ? 'Approving…'
        : 'Approve merge'
      : busy
        ? 'Dismissing…'
        : 'Dismiss advisory';

  return (
    <Dialog
      open={advisory !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="advisory-confirm">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {/* TR-6 worklist path: a compact NAMED-kinds summary above the generic
          sentence, so the reviewer sees exactly which identifiers matched /
          contradicted. Absent on the sourcing path (kinds undefined). */}
      {summary !== null ? (
        <p className="rc-muted-line mono" data-testid="advisory-kinds">
          {summary}
        </p>
      ) : null}

      {action === 'approve' ? (
        <InlineAlert variant={contradicted ? 'error' : 'success'}>
          {contradicted
            ? 'These two subjects share an identifier but also contradict on another. Merging is a considered override — acknowledge it and say why.'
            : 'Approving merges these two subjects into one. This can be reversed later from the advisory queue.'}
        </InlineAlert>
      ) : (
        <InlineAlert variant="success">
          Dismissing keeps the two subjects separate. You can note why for the record.
        </InlineAlert>
      )}

      {overrideRequired ? (
        <label className="rc-check rc-mt-16">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I’ve reviewed the contradiction and confirm these are the same person.</span>
        </label>
      ) : null}

      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">
          {overrideRequired ? 'Justification (required)' : 'Note (optional)'}
        </span>
        <textarea
          className="rc-select"
          rows={3}
          value={justification}
          maxLength={2000}
          onChange={(e) => setJustification(e.target.value)}
          placeholder={overrideRequired ? 'Why these are the same person…' : 'Optional note…'}
        />
      </label>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
