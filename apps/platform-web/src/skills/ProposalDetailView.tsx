import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  Button,
  Dialog,
  FormField,
  InlineAlert,
  hasScope,
  useToast,
  type Session, TextArea,
} from '@aramo/fe-foundation';

import { skillsApi, type Proposal } from './skills-api';
import { ProposalStatusBadge } from './ProposalStatusBadge';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { skillErrorMessage } from './skill-errors';

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

// SKILL-TAX-1F-C2 — one AI proposal, with the human accept/reject decision. A
// decision requires platform:skill:manage AND status PENDING. Acceptance reuses the
// governed API (one atomic canonical write server-side; the browser applies nothing
// itself). If the server reports the proposal is no longer PENDING
// (SKILL_PROPOSAL_NOT_PENDING, 409), the view REFRESHES from the server and renders
// the terminal state — no retry loop, no client-side forcing.
export function ProposalDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  const canManage = hasScope(session, SKILL_MANAGE_SCOPE);
  const toast = useToast();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setProposal(await skillsApi.getProposal(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load proposal.');
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const accept = async (): Promise<void> => {
    setBusy(true);
    try {
      const updated = await skillsApi.acceptProposal(id);
      setProposal(updated);
      toast.show('Proposal accepted.');
    } catch (e) {
      // Terminal-state refresh: a non-PENDING proposal (409) means another operator
      // already decided — reload server truth and show the terminal state.
      toast.show(skillErrorMessage(e, 'Accept failed.'));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const reject = async (reason: string): Promise<void> => {
    const updated = await skillsApi.rejectProposal(id, {
      reason: reason.trim().length > 0 ? reason.trim() : null,
    });
    setProposal(updated);
  };

  if (error) return <div className="pw-page"><InlineAlert variant="error">{error}</InlineAlert></div>;
  if (!proposal) return <div className="pw-page">Loading…</div>;

  const isPending = proposal.status === 'PENDING';
  const payloadText = JSON.stringify(proposal.payload, null, 2);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Proposal — {proposal.proposal_type}</h1>
        <ProposalStatusBadge status={proposal.status} />
      </div>

      {canManage ? (
        isPending ? (
          <div className="pw-actions">
            <Button variant="primary" onClick={() => void accept()} disabled={busy}>
              {busy ? 'Working…' : 'Accept'}
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(true)} disabled={busy}>
              Reject
            </Button>
          </div>
        ) : (
          <p className="pw-notice" role="status">
            This proposal is <strong>{proposal.status}</strong> (terminal) — no further decision is possible.
          </p>
        )
      ) : (
        <span className="pw-audit__meta">Read-only (platform:skill:manage required to decide).</span>
      )}

      <dl className="pw-facts">
        <dt>Proposal ID</dt>
        <dd className="mono">{proposal.id}</dd>
        <dt>Type</dt>
        <dd>{proposal.proposal_type}</dd>
        <dt>Source</dt>
        <dd>{proposal.source}</dd>
        <dt>Status</dt>
        <dd><ProposalStatusBadge status={proposal.status} /></dd>
        <dt>Proposed</dt>
        <dd>{fmt(proposal.proposed_at)}{proposal.proposed_by ? ` · ${proposal.proposed_by.slice(0, 8)}` : ''}</dd>
        <dt>Decided</dt>
        <dd>{fmt(proposal.decided_at)}{proposal.decided_by ? ` · ${proposal.decided_by.slice(0, 8)}` : ''}</dd>
        <dt>Decision reason</dt>
        <dd>{proposal.decision_reason ?? '—'}</dd>
        <dt>Applied entity</dt>
        <dd className="mono">{proposal.applied_entity_id ?? '—'}</dd>
      </dl>

      <h3 className="pw-page__title" style={{ fontSize: '1.05rem' }}>Proposed spec</h3>
      <pre className="pw-code" style={{ overflowX: 'auto', background: 'var(--rc-surface-2, #f2f4f7)', padding: 12, borderRadius: 8 }}>
        {payloadText}
      </pre>

      {rejecting ? (
        <RejectProposalDialog
          open
          onOpenChange={(o) => !o && setRejecting(false)}
          onReject={reject}
          onDone={() => {
            setRejecting(false);
            toast.show('Proposal rejected.');
          }}
          onConflict={() => {
            setRejecting(false);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function RejectProposalDialog({
  open,
  onOpenChange,
  onReject,
  onDone,
  onConflict,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReject: (reason: string) => Promise<void>;
  readonly onDone: () => void;
  readonly onConflict: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onReject(reason);
      onOpenChange(false);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SKILL_PROPOSAL_NOT_PENDING') {
        onOpenChange(false);
        onConflict();
        return;
      }
      setError(skillErrorMessage(e, 'Reject failed.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject proposal"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working…' : 'Reject'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Reason (optional)">
        <TextArea unstyled className="tc-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Dialog>
  );
}
