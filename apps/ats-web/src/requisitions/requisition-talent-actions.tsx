import { ApiError } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { RecordTalentResponseModal } from '../communications/RecordTalentResponseModal';
import { RequisitionContactEmailComposer } from '../microsoft/RequisitionContactEmailComposer';
import { dispositionPipelineEpisode, voidPipelineEpisode } from '../pipeline/pipeline-api';
import { transitionErrorMessage } from '../pipeline/error-messages';
import { NotInConsiderationDialog, type NotInConsiderationChoice } from '../pipeline/NotInConsiderationDialog';
import type { PipelineView } from '../pipeline/types';
import type { PlacementView } from '../placement/types';
import { getPreStartRequirements } from '../pre-start/pre-start-api';
import { SendRtrLauncher } from '../rtr/SendRtrLauncher';
import { canSendRtr as canSendRtrFor, useSignSubscribed } from '../rtr/rtr-access';
import { findSubmittalForTalentJob } from '../submittals/submittals-api';
import { SUBMITTAL_STATE_LABELS } from '../submittals/types';
import type { TalentRecordView } from '../talent/types';

import { RemoveFromRequisitionModal } from './RemoveFromRequisitionModal';
import { getRequisitionTalentBoard, type BoardCardView } from './requisition-talent-board-api';
import { talentRequisition360Path, type Tr360NavState } from './talent-requisition-360/route';
import {
  placementFor,
  summarizePreStart,
  type JourneyCells,
} from './requisition-journey-helpers';
import type { RequisitionView } from './types';

// Least-visibility scope gates (shared with RequisitionDetailView). A cell read
// rides its existing scope; without it the value stays "—" and no fetch issues.
const SUBMITTAL_READ = 'submittal:create';
const PRE_START_READ = 'pre_start_requirement:read';
// The "Send RTR" affordance initiates the governed request→send lifecycle; without
// document:create the actor cannot start it, so the affordance degrades to a muted
// status (presentation least-visibility; the server re-authorizes regardless).

export interface RequisitionTalentActions {
  // Open a talent → the Talent × Requisition 360 page (same tab; Back returns here).
  readonly openTalent: (talentId: string) => void;
  // Run a card/row's one-step action in place: "Send email" opens the email composer,
  // "Record response" opens the evidence modal; any other governed action opens the
  // Talent × Requisition 360 page, where the owning domain's action lives.
  readonly runCardAction: (card: BoardCardView, talentName: string) => void;
  // Open the governed "Remove from requisition" (VOID) confirmation.
  readonly requestVoid: (pipelineId: string, talentName: string) => void;
  // Pipeline & RTR Recon Remediation Directive v1.0 R1 (DEF-6) — open the Not in consideration
  // dialog (reason required; governed DISPOSITION action).
  readonly requestNotInConsideration: (pipelineId: string, talentName: string) => void;
  // Open the compose-driven Send RTR panel (SEAM 4) for a not-yet-requested RTR.
  readonly requestSendRtr: (talentId: string, talentName: string) => void;
  // True when the actor can initiate the RTR lifecycle (document:create). Surfaces
  // gate the actionable "Send RTR" affordance on this; otherwise a muted status.
  readonly canSendRtr: boolean;
  // Server-authoritative set of VOID-eligible pipeline ids.
  readonly voidEligibleIds: ReadonlySet<string>;
  // Board display names keyed by talent_record_id (reuses `talents`).
  readonly boardTalentNames: Record<string, string>;
  // Board role · company subtitle keyed by talent_record_id (reuses `talents`).
  readonly boardTalentSubtitles: Record<string, string>;
  // User directory display names keyed by user_id — resolves the card's assigned
  // recruiter to initials (best-effort; absent id ⇒ no recruiter chip).
  readonly boardRecruiterNames: Record<string, string>;
  // Board re-fetch token + bump (a card appears/disappears).
  readonly boardRefresh: number;
  readonly bumpBoardRefresh: () => void;
  // The per-talent lazy cell cache (CLIENT / PRE-START).
  readonly cells: Record<string, JourneyCells>;
  // The card-action dialogs + VOID modal + Send RTR panel, rendered once; place next to the surface.
  readonly portals: ReactNode;
}

// The governed VOID refusals, mapped to recruiter copy. Shared by the requisition
// surfaces and the Talent × Requisition 360 page.
export function voidErrorMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.code : '';
  return code === 'PIPELINE_VOID_HAS_ENGAGEMENT'
    ? 'This Talent already has engagement on this requisition, so it can no longer be removed as an accidental add.'
    : code === 'PIPELINE_VOID_HAS_DOWNSTREAM_ACTIVITY'
      ? 'This Talent has downstream activity on this requisition and can no longer be removed as an accidental add.'
      : code === 'PIPELINE_VOID_NOT_ALLOWED_FROM_STATE'
        ? 'This Talent has progressed past the initial stage and can no longer be removed as an accidental add.'
        : code === 'PIPELINE_TRANSITION_CONFLICT'
          ? 'This Talent was updated in another session; refresh and try again.'
          : e instanceof Error
            ? e.message
            : 'Could not remove the Talent from this requisition.';
}

// The ONE talent action context — open the Talent × Requisition 360 page + in-place
// card actions (email composer / record response) + VOID flow
// (RemoveFromRequisitionModal) + CLIENT/PRE-START reads + board-refresh +
// VOID eligibility. Shared verbatim by the Talent tab (list + board) and the
// Workspace board embed so neither duplicates a handler nor re-implements the
// board. Backend/action authority is UNCHANGED: every mutation still rides the
// existing governed endpoint and the server re-checks eligibility.
export function useRequisitionTalentActions({
  req,
  companyName = null,
  pipelines,
  talents,
  placements,
  scopes,
  canReadPlacements,
  userNames,
  onPipelineRemoved,
  onPipelinesChanged,
  eagerCells = false,
  onBeforeOpenTalent,
}: {
  readonly req: RequisitionView;
  /** Client display name — a read-only field on the Send RTR panel. */
  readonly companyName?: string | null;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly placements: readonly PlacementView[];
  readonly scopes: readonly string[];
  readonly canReadPlacements: boolean;
  /** User directory display names keyed by user_id (best-effort; for recruiter initials). */
  readonly userNames?: Record<string, string>;
  readonly onPipelineRemoved: (pipelineId: string) => void;
  /** ATS-QA-1 D5 — called after an episode changes status in place (Not in consideration) so the
   *  page reloads its pipelines: the Talent tab label and "in play" count then reflect it. */
  readonly onPipelinesChanged?: () => void;
  /** Hydrate every row's CLIENT / PRE-START cells on mount (the Talent tab List). */
  readonly eagerCells?: boolean;
  /** Called right before navigating to the 360 page (the origin saves its view state). */
  readonly onBeforeOpenTalent?: () => void;
}): RequisitionTalentActions {
  const navigate = useNavigate();
  const [composerTarget, setComposerTarget] = useState<{ talentId: string; pipelineId: string } | null>(null);
  const [responseTarget, setResponseTarget] = useState<{ pipelineId: string; talentName: string } | null>(null);
  const [cells, setCells] = useState<Record<string, JourneyCells>>({});
  const [voidTarget, setVoidTarget] = useState<{ pipelineId: string; talentName: string } | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');
  const [boardRefresh, setBoardRefresh] = useState(0);
  const [voidEligibleIds, setVoidEligibleIds] = useState<ReadonlySet<string>>(new Set());
  const [nicTarget, setNicTarget] = useState<{ pipelineId: string; talentName: string } | null>(null);
  // SEAM 4 — the compose-driven Send RTR panel target (null when closed).
  const [sendRtrTarget, setSendRtrTarget] = useState<{ talentId: string; talentName: string } | null>(null);

  const canReadClient = scopes.includes(SUBMITTAL_READ);
  const canReadPreStart = scopes.includes(PRE_START_READ);
  const signSubscribed = useSignSubscribed();
  const canSendRtr = canSendRtrFor(scopes, signSubscribed);

  // Fetch ONE talent's authoritative CLIENT + PRE-START values (one read pair per
  // talent, cached). No speculative values; failures + absences collapse to "—".
  const fetchCells = useCallback(
    (talentId: string) => {
      setCells((m) => ({ ...m, [talentId]: { status: 'loading' } }));
      const clientP: Promise<string | null> = canReadClient
        ? findSubmittalForTalentJob(talentId, req.id)
            .then((r) => (r.submittal !== null ? SUBMITTAL_STATE_LABELS[r.submittal.state] : null))
            .catch(() => null)
        : Promise.resolve(null);
      const placement = canReadPlacements ? placementFor(placements, talentId) : null;
      const preStartP: Promise<string | null> =
        canReadPreStart && placement !== null
          ? getPreStartRequirements(placement.id)
              .then((r) => summarizePreStart(r))
              .catch(() => null)
          : Promise.resolve(null);
      void Promise.all([clientP, preStartP]).then(([client, prestart]) => {
        setCells((m) => ({ ...m, [talentId]: { status: 'loaded', client, prestart } }));
      });
    },
    [canReadClient, canReadPreStart, canReadPlacements, placements, req.id],
  );

  // Open a talent → the Talent × Requisition 360 page, in the same tab. The origin
  // surface persists its own view state so Back restores it.
  const openTalent = useCallback(
    (talentId: string) => {
      onBeforeOpenTalent?.();
      const state: Tr360NavState = { tr360From: 'requisition' };
      navigate(talentRequisition360Path(req.id, talentId), { state });
    },
    [navigate, req.id, onBeforeOpenTalent],
  );

  const runCardAction = useCallback(
    (card: BoardCardView, talentName: string) => {
      const action = card.next_actions.find((a) => a.key !== 'pipeline.void' && scopes.includes(a.required_scope));
      if (action?.key === 'pipeline.contact_talent' && scopes.includes('communication:email:send')) {
        setComposerTarget({ talentId: card.talent_record_id, pipelineId: card.pipeline_id });
        return;
      }
      if (action?.key === 'pipeline.record_talent_response') {
        setResponseTarget({ pipelineId: card.pipeline_id, talentName });
        return;
      }
      openTalent(card.talent_record_id);
    },
    [scopes, openTalent],
  );

  // CLIENT / PRE-START cells — the Talent tab List hydrates each row once (cache
  // hit ⇒ no refetch). The row-open that used to trigger this now navigates away.
  useEffect(() => {
    if (!eagerCells) return;
    for (const p of pipelines) {
      if (cells[p.talent_record_id] === undefined) fetchCells(p.talent_record_id);
    }
  }, [eagerCells, pipelines, cells, fetchCells]);

  // Talent display names for the Board (keyed by talent_record_id). Reuses the
  // requisition's already-loaded `talents`; the Board never re-fetches per card.
  const boardTalentNames = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(talents).map(([id, t]) => [id, `${t.first_name} ${t.last_name}`.trim()]),
      ),
    [talents],
  );

  // Role · company subtitle for the Board card, composed from the already-loaded
  // talents map (title = most-recent professional title; current_employer).
  // Authoritative talent fields — never fabricated; absent parts are dropped.
  const boardTalentSubtitles = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(talents).map(([id, t]) => [
          id,
          [t.title, t.current_employer].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join(' · '),
        ]),
      ),
    [talents],
  );

  // The user directory for resolving a card's assigned recruiter id to initials.
  // Pass-through of the page-resolved directory (best-effort).
  const boardRecruiterNames = useMemo(() => userNames ?? {}, [userNames]);

  // Fetch the server-authoritative VOID eligibility (which cards carry the
  // projected pipeline.void action). Re-runs after a removal. Best-effort.
  useEffect(() => {
    let live = true;
    getRequisitionTalentBoard(req.id)
      .then((board) => {
        if (!live) return;
        const ids = new Set<string>();
        for (const col of board.columns) {
          for (const c of col.cards) {
            if (c.next_actions.some((a) => a.key === 'pipeline.void')) ids.add(c.pipeline_id);
          }
        }
        setVoidEligibleIds(ids);
      })
      .catch(() => {
        if (live) setVoidEligibleIds(new Set());
      });
    return () => {
      live = false;
    };
  }, [req.id, boardRefresh]);

  const requestVoid = useCallback((pipelineId: string, talentName: string) => {
    setVoidError('');
    setVoidTarget({ pipelineId, talentName });
  }, []);

  const requestNotInConsideration = useCallback((pipelineId: string, talentName: string) => {
    setNicTarget({ pipelineId, talentName });
  }, []);

  // R1 (DEF-6) — record Not in consideration with its reason. The CAS token is the loaded
  // episode's version; the server is authoritative and its typed refusal is shown in the dialog.
  const confirmNotInConsideration = useCallback(
    async (choice: NotInConsiderationChoice) => {
      if (nicTarget === null) return;
      const episode = pipelines.find((p) => p.id === nicTarget.pipelineId);
      if (episode === undefined) return;
      await dispositionPipelineEpisode(episode.id, { ...choice, expected_version: episode.version });
      setBoardRefresh((n) => n + 1);
      onPipelinesChanged?.();
    },
    [nicTarget, pipelines, onPipelinesChanged],
  );

  const requestSendRtr = useCallback((talentId: string, talentName: string) => {
    setSendRtrTarget({ talentId, talentName });
  }, []);

  // Confirm the correction: read the CAS token from the already-loaded pipeline,
  // call the governed endpoint, and on success remove the card locally + refresh.
  // The server is authoritative — typed refusals are surfaced verbatim.
  const confirmVoid = useCallback(async () => {
    if (voidTarget === null) return;
    const episode = pipelines.find((p) => p.id === voidTarget.pipelineId);
    if (episode === undefined) return;
    setVoidBusy(true);
    setVoidError('');
    try {
      await voidPipelineEpisode(episode.id, { reason: 'ADDED_BY_MISTAKE', expected_version: episode.version });
      onPipelineRemoved(episode.id);
      setBoardRefresh((n) => n + 1);
      setVoidTarget(null);
    } catch (e) {
      setVoidError(voidErrorMessage(e));
    } finally {
      setVoidBusy(false);
    }
  }, [voidTarget, pipelines, onPipelineRemoved]);

  const bumpBoardRefresh = useCallback(() => setBoardRefresh((n) => n + 1), []);

  const portals: ReactNode = (
    <>
      {composerTarget !== null ? (
        <RequisitionContactEmailComposer
          open
          onOpenChange={(open) => {
            if (!open) setComposerTarget(null);
          }}
          talentId={composerTarget.talentId}
          requisitionId={req.id}
          pipelineId={composerTarget.pipelineId}
          onSent={() => setBoardRefresh((n) => n + 1)}
        />
      ) : null}
      {responseTarget !== null ? (
        <RecordTalentResponseModal
          open
          pipelineId={responseTarget.pipelineId}
          talentName={responseTarget.talentName}
          reqCode={`REQ-${req.requisition_number}`}
          onRecorded={() => {
            setResponseTarget(null);
            setBoardRefresh((n) => n + 1);
          }}
          onClose={() => setResponseTarget(null)}
        />
      ) : null}
      {voidTarget !== null ? (
        <RemoveFromRequisitionModal
          talentName={voidTarget.talentName}
          busy={voidBusy}
          error={voidError}
          onCancel={() => {
            if (!voidBusy) {
              setVoidTarget(null);
              setVoidError('');
            }
          }}
          onConfirm={() => void confirmVoid()}
        />
      ) : null}
      {nicTarget !== null ? (
        <NotInConsiderationDialog
          open
          talentName={nicTarget.talentName}
          onOpenChange={(open) => {
            if (!open) setNicTarget(null);
          }}
          onConfirm={confirmNotInConsideration}
          errorMessage={transitionErrorMessage}
        />
      ) : null}
      {sendRtrTarget !== null ? (
        <SendRtrLauncher
          talentId={sendRtrTarget.talentId}
          requisitionId={req.id}
          companyId={req.company_id}
          talentName={sendRtrTarget.talentName}
          clientName={companyName}
          requisitionTitle={req.title}
          recipientEmail={talents[sendRtrTarget.talentId]?.email1 ?? null}
          onClose={() => setSendRtrTarget(null)}
          onSent={() => setBoardRefresh((n) => n + 1)}
        />
      ) : null}
    </>
  );

  return {
    openTalent,
    runCardAction,
    requestVoid,
    requestNotInConsideration,
    requestSendRtr,
    canSendRtr,
    voidEligibleIds,
    boardTalentNames,
    boardTalentSubtitles,
    boardRecruiterNames,
    boardRefresh,
    bumpBoardRefresh,
    cells,
    portals,
  };
}
