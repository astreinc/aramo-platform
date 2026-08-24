import {
  ApiError,
  Button,
  Dialog,
  FormField,
  InlineAlert,
  RadioGroup,
  type RadioOption,
  useToast,
} from '@aramo/fe-foundation';
import { useState } from 'react';

import { decideCommercialProposal } from './placement-api';
import {
  CLIENT_APPROVAL_SOURCE_LABELS,
  CLIENT_APPROVAL_SOURCE_VALUES,
  type ClientApprovalSource,
  type CommercialProposalDecisionRequest,
  type CommercialProposalMutationResponse,
  type CommercialProposalView,
} from './types';

// Slice #4 — the AUTHORITY decision dialog. Two capturing variants:
//   • 'client_approve' — record the client's approval with its evidentiary source
//     (client_approval_source, closed set), an optional client_reference, and an optional note.
//   • 'reject' — terminate the proposal with a rejection reason (carried as `note`).
// The parent mounts this ONLY for a proposal the actor may decide (approve scope AND NOT the
// proposer — segregation of duties). The server remains authoritative for SoD/policy; a 403
// SELF_APPROVAL / POLICY_DENIED surfaces as controlled inline copy. On success: toast,
// refresh server truth, close.
export type CommercialDecisionVariant = 'client_approve' | 'reject';

const SOURCE_OPTIONS: ReadonlyArray<RadioOption<ClientApprovalSource>> =
  CLIENT_APPROVAL_SOURCE_VALUES.map((value) => ({
    value,
    label: CLIENT_APPROVAL_SOURCE_LABELS[value],
  }));

interface Props {
  readonly open: boolean;
  readonly variant: CommercialDecisionVariant;
  readonly placementId: string;
  readonly proposal: CommercialProposalView;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly decideFn?: (
    id: string,
    proposalId: string,
    body: CommercialProposalDecisionRequest,
  ) => Promise<CommercialProposalMutationResponse>;
}

function messageForError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'COMMERCIAL_PROPOSAL_SELF_APPROVAL') {
    return 'You proposed this revision, so you cannot approve it. It must be decided by another authorised approver.';
  }
  if (err instanceof ApiError && err.code === 'POLICY_DENIED') {
    return 'You are not permitted to make this decision. The latest state has been refreshed.';
  }
  if (err instanceof ApiError && err.code === 'COMMERCIAL_PROPOSAL_STATE_INVALID') {
    return 'This proposal moved to a different state. The latest state has been refreshed — please review.';
  }
  return 'Could not record the decision. Please try again.';
}

export function CommercialProposalDecisionDialog({
  open,
  variant,
  placementId,
  proposal,
  onClose,
  onRefresh,
  decideFn,
}: Props) {
  const decide = decideFn ?? decideCommercialProposal;
  const toast = useToast();
  const [clientReference, setClientReference] = useState('');
  const [source, setSource] = useState<ClientApprovalSource>('MANUAL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  const isReject = variant === 'reject';

  const reset = () => {
    setClientReference('');
    setSource('MANUAL');
    setNote('');
    setBusy(false);
    setError(null);
    setFieldError({});
  };

  const submit = async () => {
    setError(null);
    if (isReject && note.trim().length === 0) {
      setFieldError({ note: 'A rejection reason is required.' });
      return;
    }
    setFieldError({});
    setBusy(true);
    const body: CommercialProposalDecisionRequest = isReject
      ? { action: 'reject', note: note.trim() }
      : {
          action: 'client_approve',
          client_approval_source: source,
          ...(clientReference.trim().length > 0 ? { client_reference: clientReference.trim() } : {}),
          ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        };
    try {
      await decide(placementId, proposal.id, body);
      toast.show(isReject ? 'Proposal rejected.' : 'Client approval recorded.');
      reset();
      onRefresh();
      onClose();
    } catch (err) {
      onRefresh();
      setError(messageForError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title={isReject ? 'Reject this proposal?' : 'Record client approval'}
      description={
        isReject
          ? 'Rejecting terminates this commercial proposal. The current terms are unchanged.'
          : 'Record the client’s approval of the proposed commercial terms and how it was obtained.'
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="commercial-proposal-decision-confirm"
          >
            {busy ? 'Saving…' : isReject ? 'Reject proposal' : 'Record approval'}
          </Button>
        </>
      }
    >
      {isReject ? (
        <FormField label="Rejection reason" error={fieldError['note']}>
          <textarea
            className="rc-input"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            data-testid="commercial-proposal-decision-note-input"
          />
        </FormField>
      ) : (
        <>
          <FormField label="Client reference (optional)">
            <input
              className="rc-input"
              value={clientReference}
              onChange={(e) => setClientReference(e.target.value)}
              disabled={busy}
              data-testid="commercial-proposal-client-reference-input"
            />
          </FormField>
          <fieldset className="rc-field">
            <legend className="rc-field__label">Approval source</legend>
            <RadioGroup
              name="commercial-proposal-client-source"
              value={source}
              options={SOURCE_OPTIONS}
              onValueChange={setSource}
              disabled={busy}
            />
          </fieldset>
          <FormField label="Note (optional)">
            <textarea
              className="rc-input"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              data-testid="commercial-proposal-decision-note-input"
            />
          </FormField>
        </>
      )}
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
