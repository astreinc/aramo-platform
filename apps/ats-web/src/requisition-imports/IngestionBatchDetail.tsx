import type { ReactNode } from 'react';

import { IngestionStatusPill } from './IngestionStatusPill';
import type { ImportBatchView } from './types';

// T8-P3 — batch detail (GET /v1/requisition-imports/:id). Renders ONLY supported
// ImportBatchView fields (§8/§16); NEVER internal tenant/user identifiers, NEVER
// per-record failures (§7/§9/§11), NEVER a created-requisition deep-link (§12).

export type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly batch: ImportBatchView }
  | { readonly status: 'error'; readonly message: string };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-row__l">
        <span className="set-row__s">{label}</span>
      </span>
      <span className="set-row__r">{children}</span>
    </div>
  );
}

export function IngestionBatchDetail({ state }: { readonly state: DetailState }) {
  return (
    <div className="rc-card--pad" data-testid="ingestion-batch-detail">
      {state.status === 'loading' && <p className="set-muted">Loading batch…</p>}
      {state.status === 'error' && (
        <p className="set-muted" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <div className="set-rows" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          <Field label="Source">{state.batch.source_filename}</Field>
          <Field label="Status">
            <IngestionStatusPill status={state.batch.status} />
          </Field>
          <Field label="Records">{String(state.batch.row_count)}</Field>
          <Field label="Imported">{String(state.batch.success_count)}</Field>
          <Field label="Failed">{String(state.batch.failure_count)}</Field>
          <Field label="Created">{formatDateTime(state.batch.created_at)}</Field>
          {state.batch.committed_at != null ? (
            <Field label="Committed">{formatDateTime(state.batch.committed_at)}</Field>
          ) : null}
          {state.batch.reverted_at != null ? (
            <Field label="Reverted">{formatDateTime(state.batch.reverted_at)}</Field>
          ) : null}
        </div>
      )}
    </div>
  );
}
