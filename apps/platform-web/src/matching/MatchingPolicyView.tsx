import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  FormField,
  InlineAlert,
  Input,
  StatusPill,
  TextArea,
  formatDate,
  hasScope,
  type PillTone,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  EVIDENCE_COUNT_MAX,
  EVIDENCE_COUNT_MIN,
  ROLE_FAMILIES,
  ROLE_FAMILY_LABELS,
  matchingPolicyApi,
  type EvidenceThresholds,
  type MatchingPolicyState,
  type MatchingPolicyStatus,
  type MatchingPolicyVersion,
  type RoleFamily,
} from './matching-policy-api';

export const MATCHING_POLICY_READ_SCOPE = 'platform:matching_policy:read';
export const MATCHING_POLICY_WRITE_SCOPE = 'platform:matching_policy:write';

const STATUS_TONE: Readonly<Record<MatchingPolicyStatus, PillTone>> = {
  ACTIVE: 'ok',
  DRAFT: 'info',
  RETIRED: 'neutral',
};

function errorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const errors = e.details?.['errors'];
  if (Array.isArray(errors) && errors.length > 0) return `${e.message}: ${errors.join('; ')}`;
  return e.message;
}

interface ThresholdRow {
  family: RoleFamily;
  count: number;
  requires_ingested: boolean;
}

function rowsOf(t: EvidenceThresholds): ThresholdRow[] {
  return ROLE_FAMILIES.map((family) => ({ family, ...t[family] }));
}

const THRESHOLD_COLUMNS: ReadonlyArray<TableColumn<ThresholdRow>> = [
  { key: 'family', header: 'Role family', render: (r) => ROLE_FAMILY_LABELS[r.family] },
  { key: 'count', header: 'Evidence count (min)', render: (r) => <span className="num">{r.count}</span> },
  {
    key: 'requires_ingested',
    header: 'Requires ingested evidence',
    render: (r) => (r.requires_ingested ? 'Yes' : 'No'),
  },
];

// ATI-SEP-1 A2 A-c (P1) — the platform-owned matching calibration. Shows the ACTIVE
// policy (the role-family evidence thresholds the ATS-side engine applies) and every
// version. Write-scope operators edit AS A NEW VERSION (a DRAFT; nothing changes until
// it is activated) and activate any non-active version — re-activating a RETIRED
// version is the rollback. Versions are append-only: a version is never edited in
// place. Tenants consume the policy and have no surface to it.
export function MatchingPolicyView({ session }: { readonly session: Session }) {
  const canWrite = hasScope(session, MATCHING_POLICY_WRITE_SCOPE);
  const [state, setState] = useState<MatchingPolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [activating, setActivating] = useState<MatchingPolicyVersion | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await matchingPolicyApi.getPolicy());
    } catch (e) {
      setError(errorMessage(e, 'Failed to load the matching policy.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const historyColumns = useMemo<ReadonlyArray<TableColumn<MatchingPolicyVersion>>>(() => {
    const base: Array<TableColumn<MatchingPolicyVersion>> = [
      { key: 'version_number', header: 'Version', render: (v) => <span className="num">v{v.version_number}</span> },
      {
        key: 'status',
        header: 'Status',
        render: (v) => <StatusPill tone={STATUS_TONE[v.status]}>{v.status}</StatusPill>,
      },
      { key: 'note', header: 'Note', render: (v) => v.note ?? '—' },
      { key: 'created_at', header: 'Created', render: (v) => formatDate(v.created_at) },
      {
        key: 'activated_at',
        header: 'Last activated',
        render: (v) => (v.activated_at !== null ? formatDate(v.activated_at) : '—'),
      },
    ];
    if (canWrite) {
      base.push({
        key: 'actions',
        header: '',
        render: (v) =>
          v.status === 'ACTIVE' ? null : (
            <Button variant="ghost" onClick={() => setActivating(v)}>
              Activate v{v.version_number}
            </Button>
          ),
      });
    }
    return base;
  }, [canWrite]);

  const active = state?.active ?? null;

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Matching policy</h1>
        {canWrite && active !== null ? (
          <Button variant="primary" onClick={() => setEditing(true)}>
            Edit as new version
          </Button>
        ) : null}
      </div>

      <div className="pw-notice" role="note">
        Platform-owned calibration for the ATS matching engine: the minimum evidence per
        critical skill for each role family. Tenants use the active version and cannot
        change it. A new version takes effect only when activated.
      </div>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <section className="pw-panel" aria-label="Active policy">
        <h2 className="pw-panel__title">
          Active policy{active !== null ? ` — v${String(active.version_number)}` : ''}
        </h2>
        {active === null && !loading && error === null ? (
          <p>No active version is stored; matching applies the compiled defaults.</p>
        ) : null}
        <DataTable
          columns={THRESHOLD_COLUMNS}
          rows={active !== null ? rowsOf(active.evidence_thresholds) : []}
          rowKey={(r) => r.family}
          emptyMessage={loading ? 'Loading…' : 'No active policy.'}
        />
      </section>

      <section className="pw-panel" aria-label="Version history">
        <h2 className="pw-panel__title">Version history</h2>
        <DataTable
          columns={historyColumns}
          rows={state?.versions ?? []}
          rowKey={(v) => v.id}
          rowMuted={(v) => v.status === 'RETIRED'}
          emptyMessage={loading ? 'Loading…' : 'No versions.'}
        />
      </section>

      {editing && active !== null ? (
        <NewVersionDialog
          base={active}
          open={editing}
          onOpenChange={setEditing}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      ) : null}
      {activating !== null ? (
        <ActivateDialog
          version={activating}
          activeNumber={active?.version_number ?? null}
          open
          onOpenChange={(o) => !o && setActivating(null)}
          onDone={() => {
            setActivating(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// ---- Edit as new version --------------------------------------------------
// Starts from the ACTIVE version's thresholds; saving creates a DRAFT version (the
// API assigns the next number). The DRAFT is activated separately.
function NewVersionDialog({
  base,
  open,
  onOpenChange,
  onDone,
}: {
  readonly base: MatchingPolicyVersion;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState<Record<RoleFamily, { count: string; requires_ingested: boolean }>>(() => {
    const out = {} as Record<RoleFamily, { count: string; requires_ingested: boolean }>;
    for (const f of ROLE_FAMILIES) {
      out[f] = {
        count: String(base.evidence_thresholds[f].count),
        requires_ingested: base.evidence_thresholds[f].requires_ingested,
      };
    }
    return out;
  });
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invalid = ROLE_FAMILIES.filter((f) => {
    const n = Number(draft[f].count);
    return !Number.isInteger(n) || n < EVIDENCE_COUNT_MIN || n > EVIDENCE_COUNT_MAX;
  });

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const evidence_thresholds = {} as EvidenceThresholds;
    for (const f of ROLE_FAMILIES) {
      evidence_thresholds[f] = { count: Number(draft[f].count), requires_ingested: draft[f].requires_ingested };
    }
    try {
      await matchingPolicyApi.createVersion({
        evidence_thresholds,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Could not create the version.'));
      setBusy(false);
    }
  };

  const editColumns: ReadonlyArray<TableColumn<RoleFamily>> = [
    { key: 'family', header: 'Role family', render: (f) => ROLE_FAMILY_LABELS[f] },
    {
      key: 'count',
      header: 'Evidence count (min)',
      render: (f) => (
        <Input
          unstyled
          aria-label={`${ROLE_FAMILY_LABELS[f]} evidence count`}
          className="tc-input"
          type="number"
          min={EVIDENCE_COUNT_MIN}
          max={EVIDENCE_COUNT_MAX}
          value={draft[f].count}
          onChange={(e) => setDraft({ ...draft, [f]: { ...draft[f], count: e.target.value } })}
          style={{ width: 96 }}
        />
      ),
    },
    {
      key: 'requires_ingested',
      header: 'Requires ingested',
      render: (f) => (
        <Checkbox
          aria-label={`${ROLE_FAMILY_LABELS[f]} requires ingested evidence`}
          checked={draft[f].requires_ingested}
          onChange={(e) => setDraft({ ...draft, [f]: { ...draft[f], requires_ingested: e.target.checked } })}
        />
      ),
    },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`New version (from v${String(base.version_number)})`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || invalid.length > 0}>
            {busy ? 'Saving…' : 'Save as draft version'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {invalid.length > 0 ? (
        <InlineAlert variant="error">
          Each evidence count must be a whole number from {EVIDENCE_COUNT_MIN} to {EVIDENCE_COUNT_MAX}.
        </InlineAlert>
      ) : null}
      <DataTable columns={editColumns} rows={[...ROLE_FAMILIES]} rowKey={(f) => f} emptyMessage="" />
      <FormField label="Note (optional)">
        <TextArea unstyled className="tc-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
    </Dialog>
  );
}

// ---- Activate ---------------------------------------------------------------
function ActivateDialog({
  version,
  activeNumber,
  open,
  onOpenChange,
  onDone,
}: {
  readonly version: MatchingPolicyVersion;
  readonly activeNumber: number | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await matchingPolicyApi.activateVersion(version.id);
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'Could not activate the version.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Activate v${String(version.version_number)}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Activating…' : 'Activate'}
          </Button>
        </>
      }
    >
      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <div className="pw-notice" role="status">
        Every new examination on every tenant will use v{version.version_number}
        {activeNumber !== null ? ` instead of v${String(activeNumber)}, which is retired` : ''}. You can
        re-activate an earlier version at any time.
      </div>
      <DataTable
        columns={THRESHOLD_COLUMNS}
        rows={rowsOf(version.evidence_thresholds)}
        rowKey={(r) => r.family}
        emptyMessage=""
      />
    </Dialog>
  );
}
