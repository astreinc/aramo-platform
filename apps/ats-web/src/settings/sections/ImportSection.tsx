import { useEffect, useState, type ReactNode } from 'react';
import { IconCompanies, IconContacts, IconRequisitions, IconTalent, IconUpload } from '@aramo/fe-foundation';

import { Button, Card } from '../../ui';
import type { ImportBatchStatus, ImportBatchView, ImportFailureView, ImportTargetEntity } from '../admin-types';
import { IMPORT_ENTITY_LABEL } from '../admin-types';
import { SettingCardHead, SettingHint, SettingsSection, StatChip } from '../components';
import { fetchImportFailures, fetchImports } from '../import-api';

// Settings Rebuild Directive 1 — Import data (LIVE, read-only).
//
// Wired to the real libs/import READ surface: the import history (GET
// /v1/imports) and per-batch failures (GET /:id/failures). Per the directive
// this is READ-ONLY — run/config is a later increment, so there is NO run
// button that would control nothing (no dead knob). The entity legend below is
// purely informational (what Aramo can bulk-import), not a control.

const ENTITY_ICON: Record<ImportTargetEntity, ReactNode> = {
  talent_record: <IconTalent />,
  requisition: <IconRequisitions />,
  company: <IconCompanies />,
  contact: <IconContacts />,
};

const STATUS_TONE: Record<ImportBatchStatus, 'ok' | 'warn' | 'info' | 'muted'> = {
  committed: 'ok',
  partial: 'warn',
  failed: 'warn',
  reverted: 'muted',
  pending: 'info',
};

const STATUS_LABEL: Record<ImportBatchStatus, string> = {
  committed: 'Completed',
  partial: 'Partial',
  failed: 'Failed',
  reverted: 'Reverted',
  pending: 'Pending',
};

type State =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly ImportBatchView[] }
  | { status: 'error'; message: string };

interface Props {
  // Test seams.
  readonly fetchImportsFn?: () => Promise<readonly ImportBatchView[]>;
  readonly fetchFailuresFn?: (id: string) => Promise<readonly ImportFailureView[]>;
}

export function ImportSection({ fetchImportsFn, fetchFailuresFn }: Props = {}) {
  const loadImports = fetchImportsFn ?? fetchImports;
  const loadFailures = fetchFailuresFn ?? fetchImportFailures;
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadImports()
      .then((items) => {
        if (!cancelled) setState({ status: 'ready', items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load import history.';
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [loadImports]);

  return (
    <SettingsSection
      title="Import data"
      description="Audit the CSV bulk-loads run into Aramo — each batch's outcome and the rows that failed validation. Running a new import is part of the recruiter import flow; configuring imports from here is on the roadmap."
    >
      <Card flush>
        <SettingCardHead
          icon={<IconUpload />}
          title="What Aramo can import"
          sub="Importable record types. Read-only here — this is the legend, not a run control."
        />
        <div className="rc-card--pad">
          <div className="set-impgrid">
            {(Object.keys(IMPORT_ENTITY_LABEL) as ImportTargetEntity[]).map((e) => (
              <div className="set-impcard" key={e}>
                <div className="set-impcard__ic">{ENTITY_ICON[e]}</div>
                <div className="set-impcard__n">{IMPORT_ENTITY_LABEL[e]}</div>
                <div className="set-impcard__d">CSV bulk-load</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card flush>
        <SettingCardHead title="Recent imports" sub="Most recent batches in this workspace." />
        <div className="rc-card--pad">
          {state.status === 'loading' && (
            <p className="set-muted">Loading import history…</p>
          )}
          {state.status === 'error' && (
            <p className="set-muted" role="alert">
              {state.message}
            </p>
          )}
          {state.status === 'ready' && state.items.length === 0 && (
            <p className="set-muted">No imports have been run in this workspace yet.</p>
          )}
          {state.status === 'ready' && state.items.length > 0 && (
            <ul className="set-rows" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {state.items.map((b) => (
                <ImportRow key={b.id} batch={b} loadFailures={loadFailures} />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <SettingHint>
        Imports never overwrite silently — verified-email rows auto-merge; phone-only and
        name+location matches go to a review queue. Reverting a batch is a tenant-admin action
        in the import engine.
      </SettingHint>
    </SettingsSection>
  );
}

function ImportRow({
  batch,
  loadFailures,
}: {
  readonly batch: ImportBatchView;
  readonly loadFailures: (id: string) => Promise<readonly ImportFailureView[]>;
}) {
  const [open, setOpen] = useState(false);
  const [failures, setFailures] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; items: readonly ImportFailureView[] }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  const hasFailures = batch.failure_count > 0;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && failures.status === 'idle' && hasFailures) {
      setFailures({ status: 'loading' });
      loadFailures(batch.id)
        .then((items) => setFailures({ status: 'ready', items }))
        .catch((err: unknown) =>
          setFailures({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load failures.',
          }),
        );
    }
  };

  const tone = STATUS_TONE[batch.status];
  const date = formatDate(batch.committed_at ?? batch.created_at);

  return (
    <li>
      <div className="set-row">
        <div className="set-row__l">
          <div className="set-row__t">
            {IMPORT_ENTITY_LABEL[batch.target_entity]} — {batch.source_filename}
          </div>
          <div className="set-row__s">
            {batch.row_count} rows · {batch.success_count} loaded
            {batch.failure_count > 0 ? ` · ${batch.failure_count} failed` : ''}
          </div>
        </div>
        <div className="set-row__r">
          <StatChip tone={tone} dot>
            {STATUS_LABEL[batch.status]}
          </StatChip>
          <span className="set-muted" style={{ padding: 0 }}>
            {date}
          </span>
          {hasFailures ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={toggle}
              aria-expanded={open}
              data-testid={`import-failures-toggle-${batch.id}`}
            >
              {open ? 'Hide failures' : 'View failures'}
            </Button>
          ) : null}
        </div>
      </div>
      {open && hasFailures ? (
        <div
          style={{ padding: '6px 0 14px 0' }}
          data-testid={`import-failures-${batch.id}`}
        >
          {failures.status === 'loading' && (
            <p className="set-muted">Loading failed rows…</p>
          )}
          {failures.status === 'error' && (
            <p className="set-muted" role="alert">
              {failures.message}
            </p>
          )}
          {failures.status === 'ready' &&
            failures.items.map((f) => (
              <div className="set-row" key={f.id}>
                <div className="set-row__l">
                  <div className="set-row__t">Row {f.row_number}</div>
                  <div className="set-row__s">
                    {f.failure_reason}
                    {f.offending_fields.length > 0
                      ? ` · fields: ${f.offending_fields.join(', ')}`
                      : ''}
                  </div>
                </div>
              </div>
            ))}
        </div>
      ) : null}
    </li>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
