import { useCallback, useEffect, useState } from 'react';
import { hasScope, useSession, type Session } from '@aramo/fe-foundation';

import { Button, Card } from '../ui';
import { SettingCardHead } from '../settings/components';
import { IngestionBatchDetail, type DetailState } from './IngestionBatchDetail';
import { IngestionBatchRow } from './IngestionBatchRow';
import { detailErrorMessage, listErrorMessage } from './error-messages';
import { getRequisitionImport, listRequisitionImports } from './requisition-imports-api';
import type { ImportBatchView } from './types';

// T8-P3 — provider-neutral requisition-ingestion MONITORING surface (VMS
// Integration §7-§8). READ-ONLY: consumes ONLY the two existing GET routes; NO
// POST/run, NO update/upsert/replay/revert, NO per-record drill-down, NO
// created-requisition deep-links, NO secrets (§9-§12). Least-visibility: gated
// on requisition:import:read (exact hasScope) — absent scope renders nothing and
// makes no fetch (§4/§5). Server truth only; no optimistic state (§17).

interface Props {
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly listFn?: () => Promise<readonly ImportBatchView[]>;
  readonly getFn?: (id: string) => Promise<ImportBatchView>;
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly ImportBatchView[] }
  | { status: 'error'; message: string };

export function RequisitionIngestionView({ sessionOverride, listFn, getFn }: Props = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, 'requisition:import:read');

  // Least-visibility: no surface and NO fetch when the read scope is absent.
  if (!canRead) return null;

  return (
    <IngestionPanel
      listFn={listFn ?? listRequisitionImports}
      getFn={getFn ?? getRequisitionImport}
    />
  );
}

function IngestionPanel({
  listFn,
  getFn,
}: {
  readonly listFn: () => Promise<readonly ImportBatchView[]>;
  readonly getFn: (id: string) => Promise<ImportBatchView>;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    listFn()
      .then((items) => {
        if (!cancelled) setList({ status: 'ready', items });
      })
      .catch((err: unknown) => {
        if (!cancelled) setList({ status: 'error', message: listErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [listFn, refreshKey]);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDetail({ status: 'loading' });
      getFn(id)
        .then((batch) => setDetail({ status: 'ready', batch }))
        .catch((err: unknown) =>
          setDetail({ status: 'error', message: detailErrorMessage(err) }),
        );
    },
    [getFn],
  );

  // §17 — a real server re-read, never optimistic; not a dead knob.
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <section data-testid="requisition-ingestion" aria-label="Requisition ingestion">
      <Card flush>
        <SettingCardHead
          title="Requisition ingestion"
          sub="Read-only monitoring of provider-neutral requisition ingestion batches received into this workspace."
        />
        <div className="rc-card--pad">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={refresh}
              data-testid="ingestion-refresh"
            >
              Refresh
            </Button>
          </div>
          {list.status === 'loading' && (
            <p className="set-muted" data-testid="ingestion-loading">
              Loading ingestion history…
            </p>
          )}
          {list.status === 'error' && (
            <p className="set-muted" role="alert" data-testid="ingestion-error">
              {list.message}
            </p>
          )}
          {list.status === 'ready' && list.items.length === 0 && (
            <p className="set-muted" data-testid="ingestion-empty">
              No requisition ingestion batches have been received in this workspace yet.
            </p>
          )}
          {list.status === 'ready' && list.items.length > 0 && (
            <div className="set-rows" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {list.items.map((b) => (
                <div role="listitem" key={b.id}>
                  <IngestionBatchRow batch={b} selected={selectedId === b.id} onSelect={select} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {selectedId != null && detail != null ? (
        <Card flush>
          <SettingCardHead title="Batch detail" sub="Ingestion batch outcome." />
          <IngestionBatchDetail state={detail} />
        </Card>
      ) : null}
    </section>
  );
}
