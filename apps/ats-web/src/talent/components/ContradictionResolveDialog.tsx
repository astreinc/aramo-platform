import { useState } from 'react';
import { Button, Dialog, InlineAlert, Select, useToast, TextArea } from '@aramo/fe-foundation';

import { resolveContradiction, type ContradictionResolution } from '../dossier-api';

/** The contradicted evidence to resolve, and the record it is resolved through. */
export interface ContradictionTarget {
  readonly assertion_id: string;
  readonly assertion_type: string;
  readonly talent_record_id: string;
}

interface Props {
  readonly item: ContradictionTarget | null;
  readonly onClose: () => void;
  /** Re-fetch so the resolved state renders. */
  readonly onResolved: () => void;
}

// TR-14 B2 → ATI-SEP-1 T10 WP3b — resolve a standing contradiction in Talent
// Intelligence (identity:resolve; the caller gates the trigger). KEEP: the
// evidence stands and its contradictions are reconciled; RETRACT: the evidence
// is wrong (only evidence this workspace contributed). A justification is
// required (R4 audit). Enrichment only — never changes the ATS record.
export function ContradictionResolveDialog({ item, onClose, onResolved }: Props) {
  const [justification, setJustification] = useState('');
  const [resolution, setResolution] = useState<ContradictionResolution>('KEEP');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const canSubmit = item !== null && !busy && justification.trim().length > 0;

  const reset = () => {
    setJustification('');
    setResolution('KEEP');
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (item === null) return;
    setBusy(true);
    setError(null);
    try {
      await resolveContradiction(item.assertion_id, item.talent_record_id, justification.trim(), resolution);
      toast.show('Contradiction resolved.');
      reset();
      onResolved();
      onClose();
    } catch {
      setError('Could not resolve the contradiction. Please try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Resolve this contradiction?"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="contradiction-confirm">
            {busy ? 'Resolving…' : 'Resolve'}
          </Button>
        </>
      }
    >
      <InlineAlert variant="success">
        Keep marks this evidence as standing and reconciles the conflict; retract marks it as wrong. Say why for the record.
      </InlineAlert>
      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">Resolution</span>
        <Select
          unstyled
          className="rc-select"
          aria-label="Resolution"
          value={resolution}
          onChange={(e) => setResolution(e.target.value === 'RETRACT' ? 'RETRACT' : 'KEEP')}
        >
          <option value="KEEP">Keep — the evidence stands</option>
          <option value="RETRACT">Retract — the evidence is wrong</option>
        </Select>
      </label>
      <label className="rc-field rc-mt-16">
        <span className="rc-field__label">Justification (required)</span>
        <TextArea
          unstyled
          className="rc-select"
          rows={3}
          value={justification}
          maxLength={2000}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="Why…"
        />
      </label>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
