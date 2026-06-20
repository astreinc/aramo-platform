import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import { Card, DataTable, StatusPill, type TableColumn } from '../../ui';
import { SettingCardHead } from '../components';

import { messageForSiteError } from './error-messages';
import {
  deactivateSite,
  deleteSite,
  fetchSites,
  reactivateSite,
} from './sites-api';
import { SiteDialog } from './SiteDialog';
import { flattenTree, type TreeRow } from './tree';
import type { SiteView } from './types';

// Settings Rebuild Directive 4 — the live Sites/branches CRUD surface (replaces
// the D1 honest seam). Lists the tenant's branches as a hierarchy, with create
// / edit / deactivate-with-confirm / guarded-delete. Server is the gate; this
// inherits the settings AdminGate (tenant:admin:* family) and surfaces the
// per-endpoint 4xx legibly.

type State =
  | { status: 'loading' }
  | { status: 'ready'; sites: SiteView[] }
  | { status: 'error'; message: string };

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; site: SiteView }
  | { kind: 'deactivate'; site: SiteView }
  | { kind: 'delete'; site: SiteView };

interface Props {
  // Test seams.
  readonly fetchFn?: typeof fetchSites;
  readonly deactivateFn?: typeof deactivateSite;
  readonly reactivateFn?: typeof reactivateSite;
  readonly deleteFn?: typeof deleteSite;
}

export function SitesPanel({
  fetchFn = fetchSites,
  deactivateFn = deactivateSite,
  reactivateFn = reactivateSite,
  deleteFn = deleteSite,
}: Props = {}) {
  const toast = useToast();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const refresh = () => {
    fetchFn()
      .then((res) => setState({ status: 'ready', sites: res.items }))
      .catch((err: unknown) =>
        setState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load branches.',
        }),
      );
  };

  useEffect(() => {
    let cancelled = false;
    fetchFn()
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', sites: res.items });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load branches.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  const sites = state.status === 'ready' ? state.sites : [];
  const rows = useMemo<TreeRow[]>(() => flattenTree(sites), [sites]);

  const onSaved = (saved: SiteView) => {
    toast.show(saved.is_active ? 'Branch saved' : 'Branch updated');
    setDialog({ kind: 'none' });
    refresh();
  };

  const onToggleActive = async (site: SiteView, activate: boolean) => {
    setBusy(true);
    setActionError('');
    try {
      if (activate) {
        await reactivateFn(site.id);
        toast.show('Branch reactivated');
      } else {
        await deactivateFn(site.id);
        toast.show('Branch deactivated');
      }
      setDialog({ kind: 'none' });
      refresh();
    } catch (err: unknown) {
      setActionError(messageForSiteError(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (site: SiteView) => {
    setBusy(true);
    setActionError('');
    try {
      await deleteFn(site.id);
      toast.show('Branch deleted');
      setDialog({ kind: 'none' });
      refresh();
    } catch (err: unknown) {
      // The in-use guard (and any other 4xx) is surfaced inside the confirm
      // dialog so the operator can switch to deactivate without losing context.
      setActionError(messageForSiteError(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<TreeRow>[] = [
    {
      key: 'name',
      header: 'Branch',
      render: ({ site, depth }) => (
        <span style={{ paddingLeft: depth * 20 }} data-testid={`site-row-${site.id}`}>
          {depth > 0 && <span className="set-muted" aria-hidden="true">↳ </span>}
          {site.name}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: ({ site }) => (
        <StatusPill tone={site.is_active ? 'ok' : 'neutral'}>
          {site.is_active ? 'Active' : 'Inactive'}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: ({ site }) => (
        <div className="rc-row-actions">
          <button
            type="button"
            className="rc-link-action"
            onClick={() => setDialog({ kind: 'edit', site })}
            data-testid={`site-edit-${site.id}`}
          >
            Edit
          </button>
          {site.is_active ? (
            <button
              type="button"
              className="rc-link-action"
              onClick={() => {
                setActionError('');
                setDialog({ kind: 'deactivate', site });
              }}
              data-testid={`site-deactivate-${site.id}`}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="rc-link-action"
              onClick={() => onToggleActive(site, true)}
              data-testid={`site-reactivate-${site.id}`}
            >
              Reactivate
            </button>
          )}
          <button
            type="button"
            className="rc-link-action rc-link-danger"
            onClick={() => {
              setActionError('');
              setDialog({ kind: 'delete', site });
            }}
            data-testid={`site-delete-${site.id}`}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <Card flush>
      <SettingCardHead
        title="Branches (sites)"
        sub="Sub-tenant partitions — headquarters, regional offices, distributed pods — with an optional parent/child hierarchy."
      />
      <div className="rc-card--pad">
        {state.status === 'error' && (
          <InlineAlert variant="error">{state.message}</InlineAlert>
        )}
        <div className="rc-formfoot" style={{ justifyContent: 'flex-end', marginTop: 0 }}>
          <Button
            onClick={() => setDialog({ kind: 'create' })}
            disabled={state.status !== 'ready'}
            data-testid="site-add"
          >
            Add branch
          </Button>
        </div>

        {state.status === 'loading' && (
          <p className="set-muted">Loading branches…</p>
        )}

        {state.status === 'ready' && rows.length === 0 && (
          <p className="set-muted" data-testid="sites-empty">
            No branches yet. Add a branch to partition this tenant into sites —
            teams and users can then be scoped to a branch.
          </p>
        )}

        {state.status === 'ready' && rows.length > 0 && (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.site.id}
            rowMuted={(r) => !r.site.is_active}
          />
        )}
      </div>

      {(dialog.kind === 'create' || dialog.kind === 'edit') && (
        <SiteDialog
          mode={dialog.kind}
          open
          onOpenChange={(next) => {
            if (!next) setDialog({ kind: 'none' });
          }}
          sites={sites}
          site={dialog.kind === 'edit' ? dialog.site : undefined}
          onSaved={onSaved}
        />
      )}

      {dialog.kind === 'deactivate' && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setDialog({ kind: 'none' });
          }}
          title="Deactivate branch"
          description={`Deactivate "${dialog.site.name}"? Members and child branches keep their references; the branch becomes inactive and can be reactivated later.`}
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDialog({ kind: 'none' })}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                onClick={() => onToggleActive(dialog.site, false)}
                disabled={busy}
                data-testid="site-deactivate-confirm"
              >
                {busy ? 'Deactivating…' : 'Deactivate'}
              </Button>
            </>
          }
        >
          {actionError !== '' && (
            <InlineAlert variant="error">{actionError}</InlineAlert>
          )}
        </Dialog>
      )}

      {dialog.kind === 'delete' && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setDialog({ kind: 'none' });
          }}
          title="Delete branch"
          description={`Permanently delete "${dialog.site.name}"? This only works for an unused branch — one with members or child branches must be deactivated instead.`}
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDialog({ kind: 'none' })}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                onClick={() => onDelete(dialog.site)}
                disabled={busy}
                data-testid="site-delete-confirm"
              >
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          {actionError !== '' && (
            <InlineAlert variant="error">{actionError}</InlineAlert>
          )}
        </Dialog>
      )}
    </Card>
  );
}
