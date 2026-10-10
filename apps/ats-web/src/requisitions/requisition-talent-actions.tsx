import { ApiError } from '@aramo/fe-foundation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { voidPipelineEpisode } from '../pipeline/pipeline-api';
import type { PipelineView } from '../pipeline/types';
import type { PlacementView } from '../placement/types';
import { getPreStartRequirements } from '../pre-start/pre-start-api';
import { SendRtrLauncher } from '../rtr/SendRtrLauncher';
import { findSubmittalForTalentJob } from '../submittals/submittals-api';
import { SUBMITTAL_STATE_LABELS } from '../submittals/types';
import type { TalentRecordView } from '../talent/types';

import { RemoveFromRequisitionModal } from './RemoveFromRequisitionModal';
import { TalentDetailPanel } from './TalentDetailPanel';
import { getRequisitionTalentBoard } from './requisition-talent-board-api';
import {
  placementFor,
  summarizePreStart,
  talentLabel,
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
const RTR_INITIATE = 'document:create';

export interface RequisitionTalentActions {
  // Open a talent → the owning side panel + lazy CLIENT/PRE-START hydration.
  readonly openRow: (p: PipelineView) => void;
  // Open the governed "Remove from requisition" (VOID) confirmation.
  readonly requestVoid: (pipelineId: string, talentName: string) => void;
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
  // The drawer + VOID modal, rendered once; place next to the surface.
  readonly portals: ReactNode;
}

// The ONE talent action context — drawer (TalentDetailPanel) + VOID flow
// (RemoveFromRequisitionModal) + lazy CLIENT/PRE-START reads + board-refresh +
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
  canEditHot,
  canReadPlacements,
  userNames,
  onToggleHot,
  onPipelineUpdated,
  onPipelineRemoved,
}: {
  readonly req: RequisitionView;
  /** Client display name — a read-only field on the Send RTR panel. */
  readonly companyName?: string | null;
  readonly pipelines: readonly PipelineView[];
  readonly talents: Record<string, TalentRecordView>;
  readonly placements: readonly PlacementView[];
  readonly scopes: readonly string[];
  readonly canEditHot: boolean;
  readonly canReadPlacements: boolean;
  /** User directory display names keyed by user_id (best-effort; for recruiter initials). */
  readonly userNames?: Record<string, string>;
  readonly onToggleHot: (talentId: string, next: boolean) => Promise<void>;
  readonly onPipelineUpdated: (updated: PipelineView) => void;
  readonly onPipelineRemoved: (pipelineId: string) => void;
}): RequisitionTalentActions {
  const [selected, setSelected] = useState<PipelineView | null>(null);
  const [cells, setCells] = useState<Record<string, JourneyCells>>({});
  const [voidTarget, setVoidTarget] = useState<{ pipelineId: string; talentName: string } | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');
  const [boardRefresh, setBoardRefresh] = useState(0);
  const [voidEligibleIds, setVoidEligibleIds] = useState<ReadonlySet<string>>(new Set());
  // SEAM 4 — the compose-driven Send RTR panel target (null when closed).
  const [sendRtrTarget, setSendRtrTarget] = useState<{ talentId: string; talentName: string } | null>(null);

  const canReadClient = scopes.includes(SUBMITTAL_READ);
  const canReadPreStart = scopes.includes(PRE_START_READ);
  const canSendRtr = scopes.includes(RTR_INITIATE);

  // Fetch ONE talent's authoritative CLIENT + PRE-START values. No cross-row
  // fan-out, no speculative values; failures + absences collapse to "—".
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

  // Open a talent row → open the panel + hydrate its cells (cache hit ⇒ no
  // refetch). The ONLY entry point for the per-talent reads.
  const openRow = useCallback(
    (p: PipelineView) => {
      setSelected(p);
      if (cells[p.talent_record_id] === undefined) fetchCells(p.talent_record_id);
    },
    [cells, fetchCells],
  );

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
      if (selected?.id === episode.id) setSelected(null);
      setBoardRefresh((n) => n + 1);
      setVoidTarget(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setVoidError(
        code === 'PIPELINE_VOID_HAS_ENGAGEMENT'
          ? 'This Talent already has engagement on this requisition, so it can no longer be removed as an accidental add.'
          : code === 'PIPELINE_VOID_HAS_DOWNSTREAM_ACTIVITY'
            ? 'This Talent has downstream activity on this requisition and can no longer be removed as an accidental add.'
            : code === 'PIPELINE_VOID_NOT_ALLOWED_FROM_STATE'
              ? 'This Talent has progressed past the initial stage and can no longer be removed as an accidental add.'
              : code === 'PIPELINE_TRANSITION_CONFLICT'
                ? 'This Talent was updated in another session; refresh and try again.'
                : e instanceof Error
                  ? e.message
                  : 'Could not remove the Talent from this requisition.',
      );
    } finally {
      setVoidBusy(false);
    }
  }, [voidTarget, pipelines, selected, onPipelineRemoved]);

  const bumpBoardRefresh = useCallback(() => setBoardRefresh((n) => n + 1), []);

  const portals: ReactNode = (
    <>
      {selected !== null ? (
        <TalentDetailPanel
          entry={selected}
          talentName={talentLabel(talents, selected.talent_record_id)}
          isNew={false}
          reqTitle={req.title}
          reqCode={`REQ-${req.requisition_number}`}
          scopes={scopes}
          isHot={talents[selected.talent_record_id]?.is_hot ?? false}
          canEditHot={canEditHot}
          onToggleHot={(next) => void onToggleHot(selected.talent_record_id, next)}
          onClose={() => setSelected(null)}
          onTransitioned={(u) => {
            onPipelineUpdated(u);
            setSelected(u);
            fetchCells(u.talent_record_id);
          }}
          canVoid={voidEligibleIds.has(selected.id)}
          onRequestVoid={requestVoid}
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
    openRow,
    requestVoid,
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
