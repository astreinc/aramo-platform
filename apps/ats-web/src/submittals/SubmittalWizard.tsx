import { Button, Card, InlineAlert } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { getRequisition } from '../requisitions/requisitions-api';
import { getTalent } from '../talent/talent-api';
import { safeErrorMessage } from '../ui';

import { AdvanceStep } from './AdvanceStep';
import { ConfirmStep } from './ConfirmStep';
import { ConfirmedView } from './ConfirmedView';
import { CreateStep } from './CreateStep';
import { RevokeDialog } from './RevokeDialog';
import { Stepper } from './Stepper';
import { canRevoke } from './submittal-state';
import {
  findMatchesForRequisition,
  findSubmittalForTalentJob,
} from './submittals-api';
import type {
  MatchListSummary,
  TalentSubmittalRecordView,
} from './types';

// SubmittalWizard — the recruiter R6 keystone feature.
//
// Route: /talent/:talentId/submittal/:requisitionId
//
// On mount: discovers whether a submittal already exists for the
// (talent, requisition) pair via GET /v1/submittals?talent_id=&job_id=
// (the R6 backend lookup folded into this PR). If found → resume at
// submittal.state. If not → fetch GET /v1/jobs/:requisitionId/matches,
// pick the matching examination for this talent, and present the
// create form.
//
// PHASE-B-CARRY (T1) — the de-facto single-backend identity convention.
// The wizard treats `requisitionId` and the `job_id` query parameter as
// the same UUID under the substrate's enforced equality:
// submittal.job_id == examination.job_id == requisition.Requisition.id.
// See submittals-api.ts header + the LOCKED carry:
// Aramo-Carry-T1-Identity-Bridge-and-ATS-Score-Store-Phase-B.md.

// uuidv4 — small inline helper. We avoid pulling a uuid lib for one call.
function uuidv4(): string {
  if (
    typeof globalThis.crypto !== 'undefined'
    && typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID; vanishingly
  // rare in modern browsers + Node 19+. Pseudo-random; safe for
  // idempotency-key purposes (we just need uniqueness per action).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'no-examination';
      message: string;
    }
  | { kind: 'ready-create'; examination: MatchListSummary }
  | { kind: 'ready-resume'; submittal: TalentSubmittalRecordView };

export function SubmittalWizard() {
  const params = useParams<{ talentId: string; requisitionId: string }>();
  const talentId = params.talentId ?? '';
  const requisitionId = params.requisitionId ?? '';

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [submittal, setSubmittal] =
    useState<TalentSubmittalRecordView | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  // The gate header context — resolved names (the records carry ids only;
  // gap #8, never a raw UUID). Best-effort: a 403/404 leaves them undefined
  // and the gate falls back to neutral copy.
  const [talentName, setTalentName] = useState<string | undefined>(undefined);
  const [reqTitle, setReqTitle] = useState<string | undefined>(undefined);

  // One idempotency key PER action. We keep a small registry so a retry
  // of the SAME logical action reuses its key (silent-replay), while a
  // distinct action (e.g. mark-ready vs revoke) gets its own key.
  // SW-5/D-1 — the Submittal Workspace now owns the MarkReady → Submit journey, so
  // the wizard no longer mints markReady/submitToAts keys: a handoff_draft /
  // ready_for_review submittal is redirected into the Workspace below. The wizard
  // retains Create (+ the create-time attestations) and confirm/placement.
  const keys = useMemo(
    () => ({
      create: uuidv4(),
      confirm: uuidv4(),
      confirmAts: uuidv4(),
      revoke: uuidv4(),
    }),
    // Keys are wizard-instance-scoped; intentionally independent of
    // submittal.state so a retried action reuses its mint.
    [],
  );

  useEffect(() => {
    if (talentId === '' || requisitionId === '') return;
    let cancelled = false;
    setLoadState({ kind: 'loading' });

    (async () => {
      try {
        // Discovery first — does a submittal already exist?
        const lookup = await findSubmittalForTalentJob(talentId, requisitionId);
        if (cancelled) return;
        if (lookup.submittal !== null) {
          setSubmittal(lookup.submittal);
          setLoadState({ kind: 'ready-resume', submittal: lookup.submittal });
          return;
        }

        // No existing submittal — resolve the examination via match-list.
        const matches = await findMatchesForRequisition(requisitionId);
        if (cancelled) return;
        const exam = matches.data.find((m) => m.talent_id === talentId);
        if (exam === undefined) {
          setLoadState({
            kind: 'no-examination',
            message:
              'No examination exists for this talent and requisition. The wizard cannot proceed.',
          });
          return;
        }
        setLoadState({ kind: 'ready-create', examination: exam });
      } catch (err) {
        if (cancelled) return;
        const msg = safeErrorMessage(err, 'Lookup failed.');
        setLoadState({
          kind: 'error',
          message: `Could not load submittal state: ${msg}`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [talentId, requisitionId]);

  // Resolve the gate header names (independent of the lifecycle lookup).
  useEffect(() => {
    if (talentId === '' || requisitionId === '') return;
    let cancelled = false;
    void Promise.allSettled([
      getTalent(talentId),
      getRequisition(requisitionId),
    ]).then(([tRes, rRes]) => {
      if (cancelled) return;
      if (tRes.status === 'fulfilled') {
        const name = `${tRes.value.first_name} ${tRes.value.last_name}`.trim();
        setTalentName(name === '' ? undefined : name);
      }
      if (rRes.status === 'fulfilled') setReqTitle(rRes.value.title);
    });
    return () => {
      cancelled = true;
    };
  }, [talentId, requisitionId]);

  if (loadState.kind === 'loading') {
    return <p className="rc-muted-line">Loading submittal…</p>;
  }
  if (loadState.kind === 'error') {
    return <InlineAlert variant="error">{loadState.message}</InlineAlert>;
  }
  if (loadState.kind === 'no-examination') {
    return (
      <Card title="Cannot start a submittal">
        <InlineAlert variant="error">{loadState.message}</InlineAlert>
      </Card>
    );
  }

  // SW-5/D-1 — de-duplicate the submit journey. Once a submittal is in preparation
  // (handoff_draft) or ready_for_review, the canonical surface is the Submittal
  // Workspace (preparation / readiness / record submittal). The wizard no longer
  // presents a competing MarkReady/Submit path; it redirects into the Workspace.
  // Create (+ attestations), confirm/placement (submitted_to_client → confirmed),
  // and the revoked terminal view remain here.
  if (
    submittal !== null &&
    (submittal.state === 'handoff_draft' || submittal.state === 'ready_for_review')
  ) {
    return (
      <Navigate to={`/talent/${talentId}/submittal/${requisitionId}/workspace`} replace />
    );
  }

  // ready-create OR ready-resume
  const currentState =
    submittal !== null ? submittal.state : 'created';

  return (
    <>
      <Stepper currentState={currentState} />

      {/* Revoked terminal state — surfaced inline (NOT a step). */}
      {submittal !== null && submittal.state === 'revoked' && (
        <Card
          title="Revoked"
          description={
            submittal.revocation_justification ?? 'No reason recorded.'
          }
        >
          <InlineAlert variant="error">
            This submittal has been revoked. The evidence package is
            preserved; the workflow record is closed.
          </InlineAlert>
        </Card>
      )}

      {/* Step 1 — Create */}
      {loadState.kind === 'ready-create' && submittal === null && (
        <CreateStep
          talentRecordId={talentId}
          requisitionId={requisitionId}
          examination={loadState.examination}
          idempotencyKey={keys.create}
          onCreated={(s) => setSubmittal(s)}
        />
      )}

      {/* Step 2 — Confirm (created → handoff_draft; the attestations) */}
      {submittal !== null && submittal.state === 'created' && (
        <ConfirmStep
          submittal={submittal}
          idempotencyKey={keys.confirm}
          onConfirmed={(s) => setSubmittal(s)}
          talentName={talentName}
          requisitionTitle={reqTitle}
        />
      )}

      {/* Confirm / placement — submitted_to_client → confirmed. The earlier
          mainline advances (handoff_draft → ready_for_review → submitted_to_client)
          are owned by the Submittal Workspace (SW-5/D-1) and redirected above. */}
      {submittal !== null && submittal.state === 'submitted_to_client' && (
        <AdvanceStep
          submittal={submittal}
          idempotencyKey={keys.confirmAts}
          onAdvanced={(s) => setSubmittal(s)}
        />
      )}

      {/* Terminal Confirmed view (evidence package). */}
      {submittal !== null && submittal.state === 'confirmed' && (
        <ConfirmedView submittal={submittal} />
      )}

      {/* Revoke affordance — visible from any non-terminal state. */}
      {submittal !== null && canRevoke(submittal.state) && (
        <div style={{ marginTop: '1.5rem' }}>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setRevokeOpen(true)}
          >
            Revoke this submittal
          </Button>
        </div>
      )}
      {submittal !== null && (
        <RevokeDialog
          open={revokeOpen}
          onOpenChange={setRevokeOpen}
          submittal={submittal}
          idempotencyKey={keys.revoke}
          onRevoked={(s) => setSubmittal(s)}
        />
      )}
    </>
  );
}
