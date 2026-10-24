import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  Button,
  Checkbox,
  Input,
  hasScope,
  useOptionalToast,
  type Session,
} from '@aramo/fe-foundation';

import {
  ConfirmDialog,
  FieldTextArea,
  Pill,
  SkeletonPanel,
  formatDate,
  permissionLabel,
  type PillSpec,
} from '../components';

import {
  COMPILED_DEFAULT_THRESHOLDS,
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
import './matching.css';

export const MATCHING_POLICY_READ_SCOPE = 'platform:matching_policy:read';
export const MATCHING_POLICY_WRITE_SCOPE = 'platform:matching_policy:write';

export const NOTE_MAX = 500;

// PLATFORM-UX-1 F-8 (handoff §9 Matching policy) — the platform-owned matching
// calibration: the ACTIVE version's role-family evidence thresholds (or "Compiled
// defaults apply" when none is active), Edit as new version (inline number
// inputs and checkboxes plus a note → a DRAFT; nothing changes until it is
// activated), and the version history with "Activate vN…" and its impact diff.
// Versions are append-only; re-activating a RETIRED version is the rollback.
// Read-scope operators see the view-only note (handoff §2).

export const STATUS_PILL: Readonly<Record<MatchingPolicyStatus, PillSpec>> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  DRAFT: { label: 'Draft', tone: 'info' },
  RETIRED: { label: 'Retired', tone: 'muted' },
};

/** "2 · ingested" — one threshold in the impact table. */
function thresholdText(t: { count: number; requires_ingested: boolean }): string {
  return `${String(t.count)}${t.requires_ingested ? ' · ingested' : ''}`;
}

export interface ImpactRow {
  readonly family: RoleFamily;
  readonly label: string;
  readonly now: string;
  readonly after: string;
  readonly changed: boolean;
}

/** The activation impact: every role family, active-now (or compiled defaults) → after. */
export function impactRows(active: EvidenceThresholds | null, next: EvidenceThresholds): ImpactRow[] {
  const base = active ?? COMPILED_DEFAULT_THRESHOLDS;
  return ROLE_FAMILIES.map((family) => {
    const a = base[family];
    const b = next[family];
    return {
      family,
      label: ROLE_FAMILY_LABELS[family],
      now: thresholdText(a),
      after: thresholdText(b),
      changed: a.count !== b.count || a.requires_ingested !== b.requires_ingested,
    };
  });
}

/** Clamp an edited count into the engine's bounds (the design clamps on input). */
export function clampCount(raw: string): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < EVIDENCE_COUNT_MIN) return EVIDENCE_COUNT_MIN;
  return Math.min(EVIDENCE_COUNT_MAX, n);
}

function errorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const errors = e.details?.['errors'];
  if (Array.isArray(errors) && errors.length > 0) return `${e.message}: ${errors.join('; ')}`;
  return e.message;
}

function cloneThresholds(t: EvidenceThresholds): EvidenceThresholds {
  const out = {} as EvidenceThresholds;
  for (const f of ROLE_FAMILIES) out[f] = { ...t[f] };
  return out;
}

export function MatchingPolicyView({ session }: { readonly session: Session }) {
  const canWrite = hasScope(session, MATCHING_POLICY_WRITE_SCOPE);
  const toast = useOptionalToast();
  const [state, setState] = useState<MatchingPolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EvidenceThresholds | null>(null);
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState<MatchingPolicyVersion | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await matchingPolicyApi.getPolicy());
    } catch (e) {
      setError(errorMessage(e, 'The matching policy couldn’t be loaded. Try again.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const active = state?.active ?? null;
  const editing = draft !== null;
  const shown = draft ?? active?.evidence_thresholds ?? COMPILED_DEFAULT_THRESHOLDS;

  const startEdit = (): void => {
    setDraft(cloneThresholds(active?.evidence_thresholds ?? COMPILED_DEFAULT_THRESHOLDS));
    setNote('');
    setSaveError(null);
  };
  const setRow = (f: RoleFamily, patch: Partial<{ count: number; requires_ingested: boolean }>): void => {
    setDraft((d) => (d === null ? d : { ...d, [f]: { ...d[f], ...patch } }));
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const v = await matchingPolicyApi.createVersion({
        evidence_thresholds: draft,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      setDraft(null);
      toast.show(`Draft v${String(v.version_number)} saved. Activate it when ready.`);
      void load();
    } catch (e) {
      setSaveError(errorMessage(e, 'The draft couldn’t be saved. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pw-mp" data-testid="matching-policy">
      <div className="pw-mp-head">
        <div>
          <h1 className="pw-mp-title">Matching policy</h1>
          <p className="pw-mp-intro">
            Minimum evidence each role family needs before a skill counts in matching, across every tenant.
          </p>
        </div>
        {canWrite && !editing && state !== null ? (
          <Button unstyled className="pw-btn pw-btn--normal" onClick={startEdit}>
            Edit as new version
          </Button>
        ) : null}
      </div>
      {!canWrite ? (
        <div className="pw-viewonly pw-mp-viewonly" role="note">
          <b className="pw-viewonly__lead">View only.</b>
          <span>
            Changing the policy needs the <b>{permissionLabel(MATCHING_POLICY_WRITE_SCOPE)}</b> permission.
          </span>
        </div>
      ) : null}
      <div className="pw-mp-grid">
        <section className="pw-mp-card" aria-labelledby="pw-mp-policy-title">
          <div className="pw-mp-card__head">
            {editing ? (
              <>
                <h2 id="pw-mp-policy-title" className="pw-mp-card__title">
                  New draft version
                </h2>
                <p className="pw-mp-card__sub">Saving creates a draft. Nothing changes until you activate it.</p>
              </>
            ) : active !== null ? (
              <>
                <h2 id="pw-mp-policy-title" className="pw-mp-card__title">
                  Active policy <span className="pw-mono">v{active.version_number}</span>
                </h2>
                <p className="pw-mp-card__sub">
                  Activated {formatDate(active.activated_at)}
                  {active.note ? ` · ${active.note}` : ''}
                </p>
              </>
            ) : (
              <>
                <h2 id="pw-mp-policy-title" className="pw-mp-card__title">
                  {state === null && error === null ? 'Active policy' : 'No active version'}
                </h2>
                <p className="pw-mp-card__sub">{state === null ? ' ' : 'Compiled defaults apply.'}</p>
              </>
            )}
          </div>
          {error !== null ? (
            <div role="alert" className="pw-alert pw-alert--error pw-mp-card__alert">
              {error}
            </div>
          ) : null}
          {state === null && error === null ? (
            <SkeletonPanel lines={['100%', '100%', '100%', '100%', '100%', '100%', '100%', '100%', '100%']} />
          ) : null}
          {state !== null ? (
            <table className="pw-mp-table">
              <thead>
                <tr>
                  <th className="pw-mp-th--family">Role family</th>
                  <th className="pw-mp-th--count">Min. evidence</th>
                  <th className="pw-mp-th--ing">Ingested evidence</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_FAMILIES.map((f) => {
                  const t = shown[f];
                  return (
                    <tr key={f} data-testid={`mp-row-${f}`}>
                      <td className="pw-mp-td--family">{ROLE_FAMILY_LABELS[f]}</td>
                      <td className="pw-mp-td--count">
                        {draft !== null ? (
                          <Input
                            unstyled
                            className="pw-mp-num"
                            type="number"
                            min={EVIDENCE_COUNT_MIN}
                            max={EVIDENCE_COUNT_MAX}
                            aria-label={`${ROLE_FAMILY_LABELS[f]}: minimum evidence`}
                            value={String(t.count)}
                            onChange={(e) => setRow(f, { count: clampCount(e.target.value) })}
                          />
                        ) : (
                          <span className="pw-mp-count">{t.count}</span>
                        )}
                      </td>
                      <td className="pw-mp-td--ing">
                        {draft !== null ? (
                          <label className="pw-mp-check">
                            <Checkbox
                              unstyled
                              className="pw-mp-check__box"
                              aria-label={`${ROLE_FAMILY_LABELS[f]}: ingested evidence required`}
                              checked={t.requires_ingested}
                              onChange={(e) => setRow(f, { requires_ingested: e.target.checked })}
                            />
                            Required
                          </label>
                        ) : t.requires_ingested ? (
                          'Required'
                        ) : (
                          'Not required'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          {editing ? (
            <div className="pw-mp-edit">
              <FieldTextArea label="Note (optional)" value={note} onChange={setNote} max={NOTE_MAX} rows={2} />
              {saveError !== null ? (
                <div role="alert" className="pw-alert pw-alert--error">
                  {saveError}
                </div>
              ) : null}
              <div className="pw-mp-edit__actions">
                <Button unstyled className="pw-mp-btn pw-mp-btn--secondary" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  unstyled
                  className="pw-mp-btn pw-mp-btn--normal"
                  disabled={saving}
                  aria-busy={saving || undefined}
                  onClick={() => void saveDraft()}
                >
                  Save draft version
                </Button>
              </div>
            </div>
          ) : null}
        </section>
        <section className="pw-mp-card" aria-labelledby="pw-mp-history-title">
          <div className="pw-mp-card__head">
            <h2 id="pw-mp-history-title" className="pw-mp-card__title">
              Version history
            </h2>
          </div>
          {state === null && error === null ? <SkeletonPanel /> : null}
          {state !== null && state.versions.length === 0 ? (
            <div className="pw-mp-none">No versions yet.</div>
          ) : null}
          {(state?.versions ?? []).map((v) => {
            const p = STATUS_PILL[v.status];
            return (
              <div key={v.id} className="pw-mp-hist" data-testid={`mp-version-${String(v.version_number)}`}>
                <b className="pw-mp-hist__v">v{v.version_number}</b>
                <Pill tone={p.tone}>{p.label}</Pill>
                <span className="pw-mp-hist__body">
                  <span className="pw-mp-hist__note">{v.note ?? '—'}</span>
                  <span className="pw-mp-hist__meta">
                    Created {formatDate(v.created_at)} · last activated {formatDate(v.activated_at)}
                  </span>
                </span>
                {canWrite && v.status !== 'ACTIVE' ? (
                  <Button unstyled className="pw-mp-activate" onClick={() => setActivating(v)}>
                    Activate v{v.version_number}…
                  </Button>
                ) : null}
              </div>
            );
          })}
        </section>
      </div>
      {activating !== null ? (
        <ActivateDialog
          version={activating}
          active={active}
          onClose={() => setActivating(null)}
          onDone={() => {
            toast.show(`v${String(activating.version_number)} is now active.`);
            setActivating(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Activate vN (720px, with the impact diff) ──────────────────────────────

export function ActivateDialog({
  version,
  active,
  onClose,
  onDone,
}: {
  readonly version: MatchingPolicyVersion;
  readonly active: MatchingPolicyVersion | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = String(version.version_number);
  const rows = impactRows(active?.evidence_thresholds ?? null, version.evidence_thresholds);

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await matchingPolicyApi.activateVersion(version.id);
      onDone();
    } catch (e) {
      setError(errorMessage(e, 'The version couldn’t be activated. Try again.'));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      wide
      title={`Activate v${n}`}
      from={
        active !== null
          ? { label: `v${String(active.version_number)} active`, tone: 'ok' }
          : { label: 'Compiled defaults', tone: 'neutral' }
      }
      to={{ label: `v${n} active`, tone: 'ok' }}
      consequence={`Matching across every tenant uses these thresholds from the next matching run. ${
        active !== null ? `v${String(active.version_number)} is retired and can be activated again later.` : ''
      }`.trim()}
      error={error}
      commitLabel={`Activate v${n}`}
      tone="privileged"
      busy={busy}
      onCommit={() => void commit()}
    >
      <table className="pw-mp-impact" aria-label="Impact of activation">
        <thead>
          <tr>
            <th>Role family</th>
            <th>Active now</th>
            <th>After activation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.family}
              className={r.changed ? 'pw-mp-impact__row pw-mp-impact__row--changed' : 'pw-mp-impact__row'}
              data-changed={r.changed || undefined}
            >
              <td>{r.label}</td>
              <td className="pw-mp-impact__now">{r.now}</td>
              <td className="pw-mp-impact__after">
                <span className="pw-mp-impact__mark" aria-hidden="true">
                  {r.changed ? '●' : ''}
                </span>{' '}
                {r.changed ? <span className="pw-sr-only">Changed: </span> : null}
                {r.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ConfirmDialog>
  );
}
