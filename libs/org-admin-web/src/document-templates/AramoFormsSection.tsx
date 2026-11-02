import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { safeErrorMessage, useToast, type Session } from '@aramo/fe-foundation';
import {
  canApproveTemplates,
  fmtDate,
  listFixedForms,
  setFixedFormHidden,
  templateProductsLine,
  type TenantFixedForm,
} from '@aramo/document-templates-web';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — Aramo fixed legal forms in
// Org Home "Our templates". A fixed form is never adopted: every published form tagged with a
// product the organization is entitled to is listed here as "Aramo form · read-only", shown by
// default, with Preview (no edit, no copy). An organization admin (document_template:manage)
// hides a form it does not use — a hidden form is not offered in Aramo Sign — and shows it
// again. The server decides what is listed and refuses Hide / Show without :manage.

export const ARAMO_FORMS_COLUMNS = 'minmax(240px,1.8fr) minmax(140px,1fr) 70px 96px minmax(170px,1fr) 250px';

interface Props {
  readonly session: Session;
  readonly listFn?: typeof listFixedForms;
  readonly setHiddenFn?: typeof setFixedFormHidden;
}

export function AramoFormsSection({ session, listFn = listFixedForms, setHiddenFn = setFixedFormHidden }: Props) {
  const toast = useToast();
  const [forms, setForms] = useState<readonly TenantFixedForm[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const canManage = canApproveTemplates(session);

  const load = useCallback(async () => {
    // A failed read hides the section (Our templates stays usable), never breaks the page.
    const list = await listFn().catch((): readonly TenantFixedForm[] => []);
    setForms(Array.isArray(list) ? list : []);
  }, [listFn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forms === null || forms.length === 0) return null;

  async function toggle(f: TenantFixedForm) {
    setBusy(f.id);
    setError(null);
    try {
      const next = await setHiddenFn(f.id, !f.hidden);
      setForms((cur) => (cur ?? []).map((x) => (x.id === f.id ? next : x)));
      toast.show(next.hidden ? `${f.name} is hidden. It is no longer offered when sending.` : `${f.name} is shown again.`);
    } catch (err) {
      setError({ id: f.id, message: safeErrorMessage(err, 'Could not change this form.') });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="ox-card ox-table-wrap ox-tpl__forms" aria-label="Aramo forms" data-testid="aramo-forms">
      <div className="ox-table" role="table" style={{ minWidth: 900 }}>
        <div className="ox-tr ox-tr--head ox-tpl__tr" role="row" style={{ gridTemplateColumns: ARAMO_FORMS_COLUMNS }}>
          <span role="columnheader">Aramo form</span>
          <span role="columnheader">Used in</span>
          <span role="columnheader">Version</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Updated</span>
          <span role="columnheader">
            <span className="ox-sr-only">Actions</span>
          </span>
        </div>
        {forms.map((f) => (
          <div className="ox-tr ox-tpl__tr" role="row" key={f.id} style={{ gridTemplateColumns: ARAMO_FORMS_COLUMNS }} data-testid={`aramo-form-${f.id}`}>
            <span role="cell" className="ox-tpl__name">
              <span className="ox-tpl__nametext">
                <span className="ox-tpl__title">{f.name}</span>
                <span className="ox-tpl__type">Aramo form · read-only</span>
              </span>
            </span>
            <span role="cell">{templateProductsLine(f.products) || '—'}</span>
            <span role="cell" className="ox-mono ox-tpl__ver">
              v{f.version_number}
            </span>
            <span role="cell">
              <span className={`ox-pill ${f.hidden ? 'ox-pill--disabled' : 'ox-pill--active'}`}>{f.hidden ? 'Hidden' : 'Shown'}</span>
            </span>
            <span role="cell" className="ox-tpl__when">
              {/* A published withdrawal: the form leaves Our templates and Aramo Sign on this date. */}
              {f.withdraw_effective_at !== null ? `Withdrawn from ${fmtDate(f.withdraw_effective_at)}` : fmtDate(f.updated_at)}
            </span>
            <span role="cell" className="ox-tpl__act">
              {canManage ? (
                <button
                  type="button"
                  className="ox-btn ox-btn--secondary ox-tpl__manage"
                  disabled={busy !== null}
                  onClick={() => void toggle(f)}
                  aria-label={`${f.hidden ? 'Show' : 'Hide'} ${f.name}`}
                  data-testid={`aramo-form-toggle-${f.id}`}
                >
                  {f.hidden ? 'Show' : 'Hide'}
                </button>
              ) : null}
              <Link className="ox-btn ox-btn--secondary ox-tpl__manage" to={`/org/document-templates/forms/${encodeURIComponent(f.id)}`} aria-label={`Preview ${f.name}`}>
                Preview
              </Link>
              {error?.id === f.id ? (
                <span className="ox-error ox-tpl__acterr" role="alert">
                  {error.message}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
