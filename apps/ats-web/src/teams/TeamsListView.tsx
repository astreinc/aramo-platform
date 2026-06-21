import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Button,
  Card,
  DataTable,
  InlineAlert,
  PageHeader,
  StatusPill,
  type TableColumn,
} from '../ui';
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

import { CreateTeamDialog } from './CreateTeamDialog';
import { fetchTeams } from './teams-api';
import type { TeamRow } from './types';

// TeamsListView at /admin/teams. §5 D4c — owner NAME column resolves via the
// directory (incl. a departed owner); the create-team owner PICKER uses the
// assignable endpoint. No 403 fallback (raw user_id only as a pre-load default).

interface Props {
  fetchTeamsFn?: () => Promise<{ items: readonly TeamRow[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; teams: readonly TeamRow[] }
  | { status: 'error'; message: string };

function ownerDisplay(
  team: TeamRow,
  names: Record<string, string>,
): { primary: string } {
  return { primary: names[team.owner_user_id] ?? team.owner_user_id };
}

export function TeamsListView({
  fetchTeamsFn,
  fetchAssignableFn,
  resolveNamesFn,
}: Props = {}) {
  const fetchTeamsFun = fetchTeamsFn ?? fetchTeams;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pickerUsers, setPickerUsers] = useState<readonly AssignableUser[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
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
    void fetchAssignableFun()
      .then((users) => {
        if (!cancelled) setPickerUsers(users);
      })
      .catch(() => {
        if (!cancelled) setPickerUsers([]);
      });
    void resolveNamesFun().then((m) => {
      if (!cancelled) setNames(m);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchTeamsFun, fetchAssignableFun, resolveNamesFun]);

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
        const od = ownerDisplay(t, names);
        return (
          <>
            <span>{od.primary}</span>
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
        users={pickerUsers}
        onCreated={() => refresh()}
      />
    </section>
  );
}
