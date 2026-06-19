import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { probeUserRoster, type TenantUserView, type UserRosterState } from '../assignments/roster';
import {
  Button,
  Card,
  DataTable,
  InlineAlert,
  PageHeader,
  StatusPill,
  type TableColumn,
} from '../ui';

import { CreateTeamDialog } from './CreateTeamDialog';
import { fetchTeams } from './teams-api';
import type { TeamRow } from './types';

// TeamsListView at /admin/teams (ported to ats-web, FE Consolidation Directive
// 5; restyled to Confident Blue). List + create. The owner column joins against
// the shared roster client-side; on 403 it shows the raw user_id.

interface Props {
  fetchTeamsFn?: () => Promise<{ items: readonly TeamRow[] }>;
  probeRosterFn?: () => Promise<UserRosterState>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; teams: readonly TeamRow[] }
  | { status: 'error'; message: string };

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

export function TeamsListView({ fetchTeamsFn, probeRosterFn }: Props = {}) {
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
        <Link
          to={`/admin/teams/${t.id}`}
          className="rc-link-action"
          data-testid={`team-link-${t.id}`}
        >
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
            <span>{od.primary}</span>
            {od.secondary !== undefined && (
              <span className="rc-cell-sub"> · {od.secondary}</span>
            )}
          </>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (t) => (
        <StatusPill tone={t.is_active ? 'ok' : 'neutral'}>
          {t.is_active ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '160px',
      align: 'right',
      render: (t) => (
        <Link to={`/admin/teams/${t.id}`} data-testid={`team-actions-${t.id}`}>
          <Button variant="ghost" size="sm">
            View members
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <section className="rc-stack">
      <PageHeader
        title="Teams"
        description="Group users into pods. Each team has a single owner (the AM)."
      />
      <div className="rc-formfoot">
        <span className="rc-muted-line">
          {state.status === 'ready'
            ? `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button onClick={() => setCreateOpen(true)} data-testid="open-create-team">
          Create team
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading teams…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <Card flush>
          <DataTable<TeamRow>
            columns={columns}
            rows={state.teams}
            rowKey={(t) => t.id}
            rowMuted={(t) => !t.is_active}
            emptyMessage="No teams yet. Create one to start grouping users."
          />
        </Card>
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
