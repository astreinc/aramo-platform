import { IngestionStatusPill } from './IngestionStatusPill';
import type { ImportBatchView } from './types';

// T8-P3 — one ingestion-batch row. A keyboard-actionable button (§19) that opens
// the batch detail. Shows the non-secret source label, canonical status, and
// aggregate counts only — NO per-record failure drill-down, NO deep-link,
// NO internal tenant/user identifiers (§7/§9/§11/§12).

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function IngestionBatchRow({
  batch,
  selected,
  onSelect,
}: {
  readonly batch: ImportBatchView;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const date = formatDate(batch.committed_at ?? batch.created_at);
  return (
    <button
      type="button"
      className={`set-row set-row--btn${selected ? ' on' : ''}`}
      data-testid={`ingestion-batch-row-${batch.id}`}
      aria-pressed={selected}
      onClick={() => onSelect(batch.id)}
    >
      <span className="set-row__l">
        <span className="set-row__t">{batch.source_filename}</span>
        <span className="set-row__s">
          {batch.row_count} records · {batch.success_count} imported
          {batch.failure_count > 0 ? ` · ${batch.failure_count} failed` : ''}
        </span>
      </span>
      <span className="set-row__r">
        <IngestionStatusPill status={batch.status} />
        <span className="set-muted" style={{ padding: 0 }}>
          {date}
        </span>
      </span>
    </button>
  );
}
