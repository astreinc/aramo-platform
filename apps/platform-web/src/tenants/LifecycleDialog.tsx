import { useEffect, useState } from 'react';

import { ConfirmDialog, FieldAck, FieldSelect, FieldText, FieldTextArea, tenantStatusPill } from '../components';
import { platformApi, type LifecycleActionResult } from '../platform-api';

import {
  EMPTY_LIFECYCLE_VALUES,
  LIFECYCLE_ACTIONS,
  lifecycleValuesComplete,
  type LifecycleActionKey,
  type LifecycleValues,
} from './lifecycle-reasons';
import { alreadyInStatusCopy, lifecycleErrorCopy, type ErrorCopy } from './tenant-errors';

// PLATFORM-UX-1 F-5 (handoff §7; directive R-15) — one lifecycle transition in
// the confirm-dialog pattern: the Change box (current status → target), the
// consequence, the action's fields from lifecycle-reasons.ts, and the commit in
// the action's tone (terracotta, or danger for Close). Commit stays at 45% until
// every required field has a value. `illegal_transition` and "already in that
// status" keep the dialog open with their copy; success closes it and the caller
// toasts and refetches the timeline.

export interface LifecycleDialogProps {
  readonly action: LifecycleActionKey | null;
  readonly tenantId: string;
  readonly tenantName: string;
  /** The status the dialog opened on. */
  readonly status: string;
  readonly onClose: () => void;
  /** Called after a committed change (changed: true). */
  readonly onDone: (result: LifecycleActionResult) => void;
  /** Called when the server says the state moved underneath (refetch). */
  readonly onStale?: () => void;
}

/** The request for an action, from the dialog values (exported for tests). */
export function submitLifecycle(
  action: LifecycleActionKey,
  tenantId: string,
  v: LifecycleValues,
): Promise<LifecycleActionResult> {
  const text = v.text.trim();
  switch (action) {
    case 'suspend':
      return platformApi.suspend(tenantId, { reasonCode: v.code, reasonText: text });
    case 'reactivate':
      return platformApi.reactivate(tenantId, { reasonCode: v.code });
    case 'offboard':
      return platformApi.startOffboarding(tenantId, {
        retentionPolicyCode: v.retention,
        closeAt: new Date(`${v.closeAt}T00:00:00Z`).toISOString(),
        ...(v.code ? { reasonCode: v.code } : {}),
        ...(text ? { reasonText: text } : {}),
      });
    case 'close':
      return platformApi.close(tenantId, { reasonCode: v.code, ...(text ? { reasonText: text } : {}) });
  }
}

export function LifecycleDialog({ action, tenantId, tenantName, status, onClose, onDone, onStale }: LifecycleDialogProps) {
  const [values, setValues] = useState<LifecycleValues>(EMPTY_LIFECYCLE_VALUES);
  const [error, setError] = useState<ErrorCopy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues(EMPTY_LIFECYCLE_VALUES);
    setError(null);
    setBusy(false);
  }, [action]);

  if (action === null) return null;
  const cfg = LIFECYCLE_ACTIONS[action];
  const set = (patch: Partial<LifecycleValues>): void => {
    setValues((v) => ({ ...v, ...patch }));
    setError(null);
  };

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitLifecycle(action, tenantId, values);
      if (!res.changed) {
        setError(alreadyInStatusCopy(res.status));
        setBusy(false);
        onStale?.();
        return;
      }
      setBusy(false);
      onDone(res);
    } catch (e) {
      const copy = lifecycleErrorCopy(e, status);
      setError(copy);
      setBusy(false);
      if (copy.code === 'illegal_transition') onStale?.();
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={`${cfg.label} — ${tenantName}`}
      from={tenantStatusPill(status)}
      to={tenantStatusPill(cfg.to)}
      consequence={cfg.consequence}
      commitLabel={cfg.commit}
      tone={cfg.tone}
      canCommit={lifecycleValuesComplete(action, values)}
      busy={busy}
      onCommit={() => void commit()}
      error={
        error ? (
          <>
            {error.message} <span className="pt-err-code pt-err-code--plain">{error.code}</span>
          </>
        ) : null
      }
    >
      {cfg.fields.map((f) => {
        if (f.type === 'select') {
          const value = f.key === 'code' ? values.code : values.retention;
          return (
            <FieldSelect
              key={f.key}
              label={f.label}
              required={f.required}
              helper={'helper' in f ? f.helper : undefined}
              value={value}
              onChange={(v) => set(f.key === 'code' ? { code: v } : { retention: v })}
              options={[{ value: '', label: f.placeholder }, ...f.options]}
            />
          );
        }
        if (f.type === 'date') {
          return (
            <FieldText key={f.key} label={f.label} required type="date" value={values.closeAt} onChange={(v) => set({ closeAt: v })} />
          );
        }
        if (f.type === 'textarea') {
          return (
            <FieldTextArea
              key={f.key}
              label={f.label}
              required={f.required}
              helper={f.helper}
              max={f.max}
              value={values.text}
              onChange={(v) => set({ text: v })}
            />
          );
        }
        return <FieldAck key={f.key} label={f.label} checked={values.ack} onChange={(c) => set({ ack: c })} />;
      })}
    </ConfirmDialog>
  );
}
