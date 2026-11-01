import { useId, useState, type ReactNode } from 'react';
import { ApiError, Checkbox, Select } from '@aramo/fe-foundation';

import { CommercialRequestDialog, RequestField, type CommercialDiffRow } from '../../components';

import { catalogApi, type CatalogChangeRequest } from './catalog-api';
import {
  EMPTY_NEW_PLAN,
  NEW_PLAN_ENVELOPE_KEY,
  NEW_PLAN_SALES_MODELS,
  NEW_PLAN_STORAGE_KEY,
  buildNewPlanPayload,
  featureChoices,
  featureLabel,
  newPlanSummary,
  type NewPlanForm,
} from './new-plan-model';

// CCP PLAN_CREATE (Aramo-CCP-Amendment-PLAN_CREATE-Console-Plan-Creation, catalog row 17) — the Catalog
// screen's "New plan" dialog (catalog manager only). It CREATES A CHANGE REQUEST (PLAN_CREATE, Finance →
// Owner) and submits it; it never creates a plan (PLATFORM-UX-1 Amendment A1-2). Only AVAILABLE
// capabilities are offered (PC-4); the server re-validates everything and refuses a taken key (PC-6).

function FormRow({ label, children }: { readonly label: string; readonly children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <label className="pw-crd__field" htmlFor={id}>
      <span className="pw-crd__label">{label}</span>
      {children(id)}
    </label>
  );
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return `catalog-plan-create-${c?.randomUUID ? c.randomUUID() : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`}`;
}

export interface NewPlanDialogProps {
  readonly availableKeys: readonly string[];
  readonly existingKeys: readonly string[];
  readonly chain: ReactNode;
  readonly onClose: () => void;
  readonly onSubmitted: (req: CatalogChangeRequest) => void;
}

export function NewPlanDialog({ availableKeys, existingKeys, chain, onClose, onSubmitted }: NewPlanDialogProps) {
  const [form, setForm] = useState<NewPlanForm>(EMPTY_NEW_PLAN);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (patch: Partial<NewPlanForm>) => setForm((f) => ({ ...f, ...patch }));
  const built = buildNewPlanPayload(form, availableKeys, existingKeys);
  const choices = featureChoices(availableKeys);
  const summary: CommercialDiffRow[] = built.payload === null ? [] : newPlanSummary(built.payload).map((r) => ({ field: r.field, before: '—', after: r.value, changed: true }));

  const submit = async (): Promise<void> => {
    if (built.payload === null) return;
    setBusy(true);
    setError(null);
    try {
      const req = await catalogApi.requestPlanCreate({ payload: built.payload, reason: reason.trim(), evidence: evidence.trim(), idempotency_key: newIdempotencyKey() });
      onSubmitted(req);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request couldn’t be submitted. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CommercialRequestDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New plan · Aramo Sign"
      sub="Nothing is created until Finance and an Owner approve this request and you apply it. The new plan then appears with version 1 published. It is not sold by self-service until a provider price is set."
      diff={summary}
      chain={chain}
      alert={error ?? (built.errors.length > 0 && form !== EMPTY_NEW_PLAN ? built.errors.join(' ') : null)}
      commitLabel="Submit for approval"
      tone="terra"
      canCommit={built.payload !== null && reason.trim().length > 0 && evidence.trim().length > 0}
      busy={busy}
      onCommit={() => void submit()}
    >
      <RequestField label="Plan key" value={form.planKey} onChange={(v) => edit({ planKey: v })} placeholder="aramo-sign-team-v2" />
      <RequestField label="Name" value={form.name} onChange={(v) => edit({ name: v })} placeholder="Team" />
      <RequestField label="Description" value={form.description} onChange={(v) => edit({ description: v })} placeholder="What the plan is for" multiline />
      <FormRow label="For">
        {(id) => (
          <Select id={id} unstyled className="pw-select" value={form.tenantKind} onChange={(e) => edit({ tenantKind: e.target.value as NewPlanForm['tenantKind'] })}>
            <option value="BUSINESS">Business organizations</option>
            <option value="PERSONAL">Personal accounts</option>
          </Select>
        )}
      </FormRow>
      <FormRow label="Sales channel">
        {(id) => (
          <Select id={id} unstyled className="pw-select" value={form.salesModel} onChange={(e) => edit({ salesModel: e.target.value as NewPlanForm['salesModel'] })}>
            {NEW_PLAN_SALES_MODELS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </Select>
        )}
      </FormRow>
      {form.salesModel === 'SELF_SERVICE' ? <RequestField label="Price per month (USD)" value={form.price} onChange={(v) => edit({ price: v })} placeholder="15" /> : null}
      <RequestField label="Commitment (months)" value={form.commitmentMonths} onChange={(v) => edit({ commitmentMonths: v })} placeholder="Empty for none" />
      <FormRow label="Support tier">
        {(id) => (
          <Select id={id} unstyled className="pw-select" value={form.supportTier} onChange={(e) => edit({ supportTier: e.target.value as NewPlanForm['supportTier'] })}>
            <option value="BASIC">Basic</option>
            <option value="CONTRACTED">Contracted</option>
            <option value="">None</option>
          </Select>
        )}
      </FormRow>
      <RequestField label="Display order" value={form.displayOrder} onChange={(v) => edit({ displayOrder: v })} placeholder="1 to 899" />
      {availableKeys.includes(NEW_PLAN_ENVELOPE_KEY) ? (
        <>
          <RequestField label="Envelopes per month" value={form.envelopesUnlimited ? '' : form.envelopes} onChange={(v) => edit({ envelopes: v })} placeholder="Empty: not included" />
          <label className="pw-crd__field">
            <span>
              <Checkbox unstyled checked={form.envelopesUnlimited} onChange={(e) => edit({ envelopesUnlimited: e.target.checked })} /> Unlimited envelopes
            </span>
          </label>
        </>
      ) : null}
      {availableKeys.includes(NEW_PLAN_STORAGE_KEY) ? (
        <>
          <RequestField label="Storage (GB)" value={form.storageUnlimited ? '' : form.storageGb} onChange={(v) => edit({ storageGb: v })} placeholder="Empty: not included" />
          <label className="pw-crd__field">
            <span>
              <Checkbox unstyled checked={form.storageUnlimited} onChange={(e) => edit({ storageUnlimited: e.target.checked })} /> Unlimited storage
            </span>
          </label>
        </>
      ) : null}
      <label className="pw-crd__field">
        <span>
          <Checkbox unstyled checked={form.atsRequired} onChange={(e) => edit({ atsRequired: e.target.checked })} /> Requires an Aramo ATS subscription
        </span>
      </label>
      <div className="pw-crd__field" role="group" aria-label="Features">
        <span className="pw-crd__label">Features (only available ones are listed)</span>
        {choices.map((k) => (
          <label key={k}>
            <Checkbox
              unstyled
              checked={form.features.includes(k)}
              onChange={() => edit({ features: form.features.includes(k) ? form.features.filter((x) => x !== k) : [...form.features, k] })}
            />{' '}
            {featureLabel(k)}
          </label>
        ))}
      </div>
      <RequestField label="Reason" value={reason} onChange={setReason} placeholder="Why this plan is needed" multiline />
      <RequestField label="Evidence" value={evidence} onChange={setEvidence} placeholder="Pricing decision, ticket or document reference" />
    </CommercialRequestDialog>
  );
}
