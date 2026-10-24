import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, Button, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import {
  DiffView,
  Pill,
  SegmentedFilter,
  SkeletonPanel,
  formatDateRelative,
  formatDate,
  type SegmentOption,
} from '../components';
import { useEntityCrumb } from '../shell/crumbs';

import { skillsApi, type Proposal, type ProposalStatus, type SkillAlias, type SkillRelationship } from './skills-api';
import { proposalStatusPill, proposalTypeLabel, relationshipSourceLabel } from './skill-labels';
import { PAYLOAD_INVALID_COPY, isNotPending, notPendingMessage, skillErrorMessage } from './skill-errors';
import { useSkillDirectory, type SkillDirectory } from './skill-directory';
import { buildProposalDiff, diffTitle, parseProposal, proposalSubjectId, proposalSummary } from './proposal-diff';
import { RejectProposalDialog } from './skill-dialogs';
import { SKILL_MANAGE_SCOPE } from './SkillsRegistryView';
import { MANAGE_SKILLS_LABEL, SkillsPageHead } from './skills-chrome';

export type ProposalFilter = ProposalStatus | 'ALL';
const FILTERS: readonly ProposalFilter[] = ['PENDING', 'ACCEPTED', 'REJECTED', 'ALL'];
/** The list read is one request (no server paging); counts reflect what it returns. */
export const PROPOSAL_LIST_LIMIT = 500;

export function parseFilter(raw: string | null): ProposalFilter {
  return raw !== null && (FILTERS as readonly string[]).includes(raw) ? (raw as ProposalFilter) : 'PENDING';
}

export function filterProposals(list: readonly Proposal[], f: ProposalFilter): Proposal[] {
  return list.filter((p) => f === 'ALL' || p.status === f);
}

interface Alert {
  readonly tone: 'warn' | 'error';
  readonly text: string;
}

// PLATFORM-UX-1 F-7 — Skill proposals (handoff §9; directive R-9): status
// segmented (Pending default · Accepted · Rejected · All), a list and a detail
// pane. The selected proposal lives in the URL (/skills/proposals/:id), so a
// proposal can be linked; the list route selects the first row of the filter.
// Accept and apply / Reject… only while Pending, and only with
// platform:skill:manage (otherwise the view-only line). A 409
// SKILL_PROPOSAL_NOT_PENDING refreshes the list and shows the warning alert.
export function ProposalsView({
  session,
  selectedId,
}: {
  readonly session: Session | null;
  readonly selectedId: string | null;
}) {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const [params] = useSearchParams();
  const filter = parseFilter(params.get('status'));
  const canManage = session !== null && hasScope(session, SKILL_MANAGE_SCOPE);
  const directory = useSkillDirectory();

  const [all, setAll] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Proposal | null>(null);
  const [alert, setAlert] = useState<Alert | null>(null);

  const loadList = useCallback(async (): Promise<Proposal[]> => {
    try {
      const res = await skillsApi.listProposals({ limit: PROPOSAL_LIST_LIMIT });
      setAll(res.proposals);
      setListError(null);
      return res.proposals;
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : 'The proposals could not be loaded.');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // A deep link to a proposal the list doesn't hold reads it on its own.
  const fromList = selectedId !== null ? all.find((p) => p.id === selectedId) ?? null : null;
  useEffect(() => {
    if (selectedId === null || loading || fromList !== null) return;
    let live = true;
    skillsApi
      .getProposal(selectedId)
      .then((p) => live && setFetched(p))
      .catch(() => live && setFetched(null));
    return () => {
      live = false;
    };
  }, [selectedId, loading, fromList]);
  const selected = fromList ?? (fetched?.id === selectedId ? fetched : null);

  const rows = useMemo(() => filterProposals(all, filter), [all, filter]);
  const query = filter === 'PENDING' ? '' : `?status=${filter}`;

  // The list route opens the first proposal of the filter (the design's default selection).
  useEffect(() => {
    if (selectedId !== null || loading) return;
    const first = rows[0];
    if (first) navigate(`/skills/proposals/${first.id}${query}`, { replace: true });
  }, [selectedId, loading, rows, navigate, query]);

  const options: SegmentOption<ProposalFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: f === 'ALL' ? 'All' : proposalStatusPill(f).label,
    count: loading ? undefined : filterProposals(all, f).length,
  }));

  const setFilter = (f: ProposalFilter): void => {
    const q = f === 'PENDING' ? '' : `?status=${f}`;
    navigate(selectedId !== null ? `/skills/proposals/${selectedId}${q}` : `/skills/proposals${q}`);
  };
  const open = (id: string): void => {
    setAlert(null);
    navigate(`/skills/proposals/${id}${query}`);
  };

  // Accept / reject: success → toast + refresh; 409 → refresh + the warning alert.
  const onConflict = async (id: string): Promise<void> => {
    const list = await loadList();
    const now = list.find((p) => p.id === id) ?? (await skillsApi.getProposal(id).catch(() => null));
    if (now && !list.some((p) => p.id === id)) setFetched(now);
    setAlert({ tone: 'warn', text: notPendingMessage(now?.status ?? null) });
  };
  const accept = async (p: Proposal): Promise<void> => {
    setAlert(null);
    try {
      await skillsApi.acceptProposal(p.id);
      toast.show('Proposal accepted and applied.');
      await loadList();
      directory.reload();
    } catch (e) {
      if (isNotPending(e)) await onConflict(p.id);
      else setAlert({ tone: 'error', text: skillErrorMessage(e, 'The proposal could not be accepted.') });
    }
  };
  const reject = async (p: Proposal, reason: string | null): Promise<void> => {
    setAlert(null);
    try {
      await skillsApi.rejectProposal(p.id, { reason });
      toast.show('Proposal rejected.');
      await loadList();
    } catch (e) {
      if (!isNotPending(e)) throw e;
      await onConflict(p.id);
    }
  };

  return (
    <div className="pw-sk">
      <SkillsPageHead
        title="Skill proposals"
        lede="AI-recommended aliases and relationships. Nothing changes until an operator accepts."
      />
      <div className="pw-sk-seg-inline">
        <SegmentedFilter label="Status" options={options} value={filter} onChange={setFilter} />
      </div>
      {listError ? (
        <div role="alert" className="pw-alert pw-alert--error pw-sk-alert">
          {listError}
        </div>
      ) : null}
      <div className="pw-sk-split">
        <section className="pw-sk-card" aria-label="Proposals">
          {loading ? (
            <div className="pw-sk-loading">
              <SkeletonPanel label="Loading proposals…" />
            </div>
          ) : (
            rows.map((p) => {
              const on = p.id === selectedId;
              const pill = proposalStatusPill(p.status);
              return (
                <Button
                  key={p.id}
                  unstyled
                  className={on ? 'pw-btn pw-sk-prow pw-sk-prow--on' : 'pw-btn pw-sk-prow'}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => open(p.id)}
                >
                  <span className="pw-sk-prow__bar" aria-hidden="true" />
                  <span className="pw-sk-prow__main">
                    <span className="pw-sk-prow__summary">{proposalSummary(p, directory)}</span>
                    <span className="pw-sk-prow__meta">
                      {proposalTypeLabel(p.proposal_type)} · {relationshipSourceLabel(p.source)} ·{' '}
                      {formatDate(p.proposed_at)}
                    </span>
                  </span>
                  <span className="pw-sk-prow__pill">
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </span>
                </Button>
              );
            })
          )}
          {!loading && rows.length === 0 ? <div className="pw-sk-empty">No proposals in this status.</div> : null}
        </section>
        {selected ? (
          <ProposalDetailPane
            proposal={selected}
            directory={directory}
            canManage={canManage}
            alert={alert}
            onAccept={() => accept(selected)}
            onReject={(reason) => reject(selected, reason)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProposalDetailPane({
  proposal,
  directory,
  canManage,
  alert,
  onAccept,
  onReject,
}: {
  readonly proposal: Proposal;
  readonly directory: SkillDirectory;
  readonly canManage: boolean;
  readonly alert: Alert | null;
  readonly onAccept: () => Promise<void>;
  readonly onReject: (reason: string | null) => Promise<void>;
}) {
  const parsed = useMemo(() => parseProposal(proposal), [proposal]);
  const subjectId = proposalSubjectId(parsed);
  const [aliases, setAliases] = useState<SkillAlias[] | null>(null);
  const [relationships, setRelationships] = useState<SkillRelationship[] | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  useEntityCrumb(proposalSummary(proposal, directory));

  // The subject skill's current collection — the diff's plain rows.
  useEffect(() => {
    setAliases(null);
    setRelationships(null);
    if (subjectId === null) return;
    let live = true;
    if (parsed.kind === 'ALIAS') {
      skillsApi
        .listAliases(subjectId)
        .then((r) => live && setAliases(r.aliases))
        .catch(() => live && setAliases([]));
    } else {
      skillsApi
        .listRelationships(subjectId)
        .then((r) => live && setRelationships(r.relationships))
        .catch(() => live && setRelationships([]));
    }
    return () => {
      live = false;
    };
  }, [subjectId, parsed.kind, proposal.status]);

  const pending = proposal.status === 'PENDING';
  const pill = proposalStatusPill(proposal.status);
  const ready = parsed.kind === 'ALIAS' ? aliases !== null : parsed.kind === 'RELATIONSHIP' ? relationships !== null : true;
  const rows = ready
    ? buildProposalDiff(proposal, parsed, { aliases: aliases ?? [], relationships: relationships ?? [] }, directory)
    : [];

  return (
    <section className="pw-sk-card pw-sk-card--open pw-sk-card--pad" aria-label="Proposal detail">
      {alert ? (
        <div role="alert" className={`pw-alert pw-alert--${alert.tone} pw-sk-alert`}>
          {alert.text}
        </div>
      ) : null}
      <div className="pw-sk-pd__head">
        <h2 className="pw-sk-pd__title">{proposalTypeLabel(proposal.proposal_type)} proposal</h2>
        <Pill tone={pill.tone}>{pill.label}</Pill>
        <span className="pw-sk-pd__id">{proposal.id}</span>
      </div>
      <div className="pw-sk-pd__meta">
        {relationshipSourceLabel(proposal.source)} · proposed {formatDateRelative(proposal.proposed_at)}
      </div>
      <div className="pw-sk-pd__difftitle">{diffTitle(parsed, directory)}</div>
      {parsed.kind === 'INVALID' ? (
        <div className="pw-sk-pd__note">{PAYLOAD_INVALID_COPY}</div>
      ) : ready ? (
        <DiffView rows={rows} label={diffTitle(parsed, directory)} />
      ) : (
        <SkeletonPanel lines={['100%', '70%']} label="Loading the current values…" />
      )}
      {proposal.status === 'REJECTED' && proposal.decision_reason ? (
        <div className="pw-sk-pd__note pw-sk-pd__note--reason">Rejection reason: {proposal.decision_reason}</div>
      ) : null}
      {pending && canManage ? (
        <div className="pw-sk-pd__decide">
          <Button
            unstyled
            className="pw-btn pw-btn--normal pw-sk-btn36 pw-sk-btn36--pad14"
            disabled={accepting}
            aria-busy={accepting || undefined}
            onClick={() => {
              setAccepting(true);
              void onAccept().finally(() => setAccepting(false));
            }}
          >
            Accept and apply
          </Button>
          <Button
            unstyled
            className="pw-btn pw-btn--secondary pw-sk-btn36 pw-sk-btn36--pad14"
            disabled={accepting}
            onClick={() => setRejecting(true)}
          >
            Reject…
          </Button>
        </div>
      ) : null}
      {pending && !canManage ? (
        <div className="pw-sk-pd__readonly" role="note">
          You can view this. Deciding proposals needs the <b>{MANAGE_SKILLS_LABEL}</b> permission.
        </div>
      ) : null}
      {rejecting ? (
        <RejectProposalDialog
          open
          onOpenChange={(o) => {
            if (!o) setRejecting(false);
          }}
          onReject={onReject}
        />
      ) : null}
    </section>
  );
}
