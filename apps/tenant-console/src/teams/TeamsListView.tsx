import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../components/Button';
import { InlineAlert } from '../components/InlineAlert';
import { PageHeader } from '../components/PageHeader';
import { Table, type TableColumn } from '../components/Table';
import type { TenantUserView } from '../users/types';
import {
  probeUserRoster,
  type UserRosterState,
} from '../users/users-api';

import { CreateTeamDialog } from './CreateTeamDialog';
import { fetchTeams } from './teams-api';
import type { TeamRow } from './types';

// Settings S5c-2 — TeamsListView at /teams.
//
// PL-94 §2 ruling 3 — sub-route layout: /teams (this view; list +
// create) + /teams/:teamId (the members editor).
//
// PL-94 §2 ruling 4 — member_count OMITTED from the list (no BE
// support; a follow-up). The list shows name / owner / status /
// actions.
//
// PL-94 §2 ruling 7 — roster-403 fallback. The owner column joins
// against the roster client-side; on 403 we show the raw user_id
// instead of the name.

interface Props {
  fetchTeamsFn?: () => Promise<{ items: readonly TeamRow[] }>;
  probeRosterFn?: () => Promise<UserRosterState>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; teams: readonly TeamRow[] }
  | { status: 'error'; message: string };

function StatusBadge({ team }: { team: TeamRow }) {
  if (team.is_active) {
    return (
      <span className="tc-badge tc-badge--active">Active</span>
    );
  }
  return <span className="tc-badge tc-badge--disabled">Inactive</span>;
}

function ownerDisplay(
  team: TeamRow,
  rosterById: ReadonlyMap<string, TenantUserView>,
): { primary: string; secondary?: string } {
  const owner = rosterById.get(team.owner_user_id);
  if (owner === undefined) {
    return { primary: team.owner_user_id };
  }
  const display = owner.display_name ?? owner.email;
  return {
    primary: display,
    secondary: owner.display_name !== null ? owner.email : undefined,
  };
}

export function TeamsListView({
  fetchTeamsFn,
  probeRosterFn,
}: Props = {}) {
  const fetchTeamsFun = fetchTeamsFn ?? fetchTeams;
  const probeRoster = probeRosterFn ?? probeUserRoster;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [roster, setRoster] = useState<UserRosterState>({ state: 'forbidden' });
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchTeamsFun()
      .then((view) => setState({ status: 'ready', teams: view.items }))
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to load teams.';
        setState({ status: 'error', message });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchTeamsFun()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', teams: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load teams.';
        setState({ status: 'error', message });
      });
    probeRoster()
      .then((next) => {
        if (cancelled) return;
        setRoster(next);
      })
      .catch(() => {
        if (cancelled) return;
        setRoster({ state: 'forbidden' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchTeamsFun, probeRoster]);

  const rosterById = useMemo(() => {
    const m = new Map<string, TenantUserView>();
    if (roster.state === 'ready') {
      for (const u of roster.users) m.set(u.user_id, u);
    }
    return m;
  }, [roster]);

  const columns: ReadonlyArray<TableColumn<TeamRow>> = [
    {
      key: 'name',
      header: 'Name',
      render: (t) => (
        <Link to={`/teams/${t.id}`} className="tc-link" data-testid={`team-link-${t.id}`}>
          {t.name}
        </Link>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (t) => {
        const od = ownerDisplay(t, rosterById);
        return (
          <>
            <div>{od.primary}</div>
            {od.secondary !== undefined && (
              <div className="tc-helper">{od.secondary}</div>
            )}
          </>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (t) => <StatusBadge team={t} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '160px',
      align: 'right',
      render: (t) => (
        <Link to={`/teams/${t.id}`} data-testid={`team-actions-${t.id}`}>
          <Button variant="ghost" size="sm">
            View members
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Teams"
        description="Group users into pods. Each team has a single owner (the AM)."
      />
      <div className="tc-page-actions">
        <span className="tc-helper">
          {state.status === 'ready'
            ? `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button onClick={() => setCreateOpen(true)} data-testid="open-create-team">
          Create team
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="tc-helper">Loading teams…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <Table<TeamRow>
          columns={columns}
          rows={state.teams}
          rowKey={(t) => t.id}
          rowMuted={(t) => !t.is_active}
          emptyMessage="No teams yet. Create one to start grouping users."
        />
      )}
      <CreateTeamDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roster={roster}
        onCreated={() => refresh()}
      />
    </section>
  );
}
