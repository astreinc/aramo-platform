import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  InlineAlert,
  Select,
  SettingsSection,
  hasScope,
  safeErrorMessage,
  useSession,
  useToast,
  type Session,
} from '@aramo/fe-foundation';
import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  DOC_TEMPLATE_READ_SCOPE,
  DocIcon,
  clearTemplateSelection,
  fetchTemplateLibrary,
  fmtDate,
  listTemplateSelections,
  setTemplateSelection,
  useDocTemplateRoutes,
  type TemplateDocumentType,
  type TemplateLibraryItem,
  type TemplateLibraryView,
  type TemplateSelectionView,
} from '@aramo/document-templates-web';

import { fetchTemplateNotices, noticeMessage, type TemplateWithdrawalNotice } from './notices-api';

// DOC-TEMPLATE-LIB-1 T-4 — Implementation Directive v1.0 (LOCKED) §8.2 (ADR-0034 D3–D6,
// D8, D10, D11): the Org Home "Document templates" section.
//   - Withdrawal notices (GET /v1/document-templates/notices, T-6).
//   - "Template in use" per document type: the tenant-wide choice (an Aramo default or
//     one of the organization's own approved templates); with no choice the Aramo default
//     applies. Changing it / reverting to the Aramo default needs document_template:manage.
//     Client-specific choices made elsewhere are listed (and can be removed); picking a
//     client here is not offered — no client lookup is reachable from the org session.
//   - Aramo defaults: the current version only, with an "Updated {date}" badge; Preview
//     renders it with this organization's branding.
//   - Your templates: the organization's own templates (open → detail / draft editor).
//   - "Create your own document template" (manage): a new template written from scratch —
//     there is no copy of an Aramo default.
// The server is the boundary: every call is @RequireScopes-gated.

const ARAMO_DEFAULT = 'aramo-default';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; library: TemplateLibraryView; selections: readonly TemplateSelectionView[] };

interface Props {
  readonly sessionOverride?: Session;
  readonly libraryFn?: typeof fetchTemplateLibrary;
  readonly selectionsFn?: typeof listTemplateSelections;
  readonly setSelectionFn?: typeof setTemplateSelection;
  readonly clearSelectionFn?: typeof clearTemplateSelection;
  readonly noticesFn?: typeof fetchTemplateNotices;
}

export function DocumentTemplatesGallery({
  sessionOverride,
  libraryFn = fetchTemplateLibrary,
  selectionsFn = listTemplateSelections,
  setSelectionFn = setTemplateSelection,
  clearSelectionFn = clearTemplateSelection,
  noticesFn = fetchTemplateNotices,
}: Props) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, DOC_TEMPLATE_READ_SCOPE);
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const toast = useToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [notices, setNotices] = useState<readonly TemplateWithdrawalNotice[]>([]);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const [library, selections] = await Promise.all([libraryFn(), selectionsFn()]);
      setLoad({ status: 'ready', library, selections });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Could not load document templates.') });
    }
  }, [libraryFn, selectionsFn]);

  useEffect(() => {
    if (!canRead) return;
    void refetch();
    void noticesFn().then(setNotices, () => setNotices([]));
  }, [canRead, refetch, noticesFn]);

  const view = useMemo(() => (load.status === 'ready' ? buildView(load.library, load.selections) : null), [load]);

  if (!canRead) {
    return (
      <SettingsSection title="Document templates">
        <p className="org-muted" data-testid="dt-gallery-noaccess">
          Document templates are managed by your organization’s owners and administrators.
        </p>
      </SettingsSection>
    );
  }

  async function choose(typeId: string, value: string) {
    setBusy(true);
    try {
      if (value === ARAMO_DEFAULT) {
        await clearSelectionFn({ document_type_id: typeId });
        toast.show('This document type now uses the Aramo default.');
      } else {
        await setSelectionFn({ document_type_id: typeId, client_id: null, template_id: value });
        toast.show('Template in use updated.');
      }
      await refetch();
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not change the template in use.'));
    } finally {
      setBusy(false);
    }
  }

  async function removeClientChoice(typeId: string, clientId: string) {
    setBusy(true);
    try {
      await clearSelectionFn({ document_type_id: typeId, client_id: clientId });
      toast.show('Client-specific template removed.');
      await refetch();
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not remove the client-specific template.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Document templates"
      description="Aramo defaults are ready to use with your organization’s branding. Create your own template when you need your own wording."
      actions={
        canManage ? (
          <Button onClick={() => navigate(`${routes.list}/new`)} data-testid="dt-create-own">
            Create your own document template
          </Button>
        ) : undefined
      }
    >
      <div className="dt-root org-dt" data-testid="dt-gallery">
        {notices.map((n) => (
          <div className="org-dt-notice" role="status" key={n.template_id} data-testid={`dt-notice-${n.template_id}`}>
            {noticeMessage(n, fmtDate, canManage)}
          </div>
        ))}

        {load.status === 'loading' ? <p className="org-muted">Loading…</p> : null}
        {load.status === 'error' ? <InlineAlert variant="error">{load.message}</InlineAlert> : null}

        {view !== null ? (
          <>
            <h2 className="org-dt-h">Template in use</h2>
            <div className="org-dt-list" data-testid="dt-in-use">
              {view.types.map((t) => (
                <div className="org-dt-row" key={t.type.id} data-testid={`dt-in-use-${t.type.key}`}>
                  <span className="org-dt-row__main">
                    <span className="org-dt-row__name">{t.type.name}</span>
                    <span className="org-muted" data-testid={`dt-in-use-current-${t.type.key}`}>
                      {t.current === null ? 'Aramo default' : `${t.current.name}${t.current.owner_scope === 'PLATFORM' ? ' · Aramo default' : ' · your template'}`}
                    </span>
                  </span>
                  {canManage ? (
                    <Select
                      unstyled
                      className="rc-input org-dt-select"
                      aria-label={`Template in use for ${t.type.name}`}
                      value={t.current === null ? ARAMO_DEFAULT : t.current.id}
                      disabled={busy}
                      onChange={(e) => void choose(t.type.id, e.target.value)}
                      data-testid={`dt-in-use-select-${t.type.key}`}
                    >
                      <option value={ARAMO_DEFAULT}>Aramo default (recommended)</option>
                      {t.choices.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.owner_scope === 'PLATFORM' ? `${c.name} · Aramo default` : `${c.name} · your template`}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  {t.clientChoices.map((c) => (
                    <span className="org-dt-row__client" key={c.selection.id} data-testid="dt-client-choice">
                      For one client: {c.name}
                      {canManage ? (
                        <Button unstyled className="dt-link" disabled={busy} onClick={() => void removeClientChoice(t.type.id, c.selection.client_id as string)}>
                          Remove
                        </Button>
                      ) : null}
                    </span>
                  ))}
                </div>
              ))}
            </div>

            <h2 className="org-dt-h">Aramo defaults</h2>
            {view.defaults.length === 0 ? <p className="org-muted">No Aramo defaults are available yet.</p> : null}
            <div className="org-dt-cards" data-testid="dt-defaults">
              {view.defaults.map((d) => (
                <div className="org-dt-card" key={d.id} data-testid={`dt-default-${d.id}`}>
                  <span className="dt-ic dt-ic--rtr"><DocIcon /></span>
                  <span className="org-dt-card__name">{d.name}</span>
                  <span className="org-muted">{view.typeName(d.document_type_id)}</span>
                  <span className="org-dt-badge" data-testid="dt-updated-badge">Updated {fmtDate(d.updated_at)}</span>
                  {d.products != null && d.products.length > 0 ? <span className="org-muted">{d.products.join(' · ')}</span> : null}
                  {d.configurable ? (
                    <Button unstyled className="dt-btn dt-btn--outline" onClick={() => navigate(`${routes.list}/aramo/${encodeURIComponent(d.id)}`)} data-testid={`dt-default-preview-${d.id}`}>
                      Preview
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>

            <h2 className="org-dt-h">Your templates</h2>
            {view.own.length === 0 ? (
              <p className="org-muted" data-testid="dt-own-empty">
                Your organization hasn’t created its own templates. The Aramo defaults are used.
              </p>
            ) : (
              <div className="org-dt-list" data-testid="dt-own">
                {view.own.map((o) => (
                  <div className="org-dt-row" key={o.id} data-testid={`dt-own-${o.id}`}>
                    <span className="org-dt-row__main">
                      <span className="org-dt-row__name">{o.name}</span>
                      <span className="org-muted">
                        {view.typeName(o.document_type_id)} · {o.status === 'ACTIVE' ? `Active v${o.current_version_number ?? '—'}` : 'Draft — not approved yet'}
                      </span>
                    </span>
                    <Button unstyled className="dt-btn dt-btn--outline" onClick={() => navigate(routes.detail(o.id))} data-testid={`dt-own-open-${o.id}`}>
                      Open
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

interface TypeRow {
  readonly type: TemplateDocumentType;
  readonly current: TemplateLibraryItem | null;
  readonly choices: readonly TemplateLibraryItem[];
  readonly clientChoices: ReadonlyArray<{ readonly selection: TemplateSelectionView; readonly name: string }>;
}

// Pure derivation of the screen from the two reads.
export function buildView(library: TemplateLibraryView, selections: readonly TemplateSelectionView[]) {
  const byId = new Map(library.items.map((i) => [i.id, i]));
  const typeNames = new Map(library.document_types.map((t) => [t.id, t.name]));
  const typeName = (id: string): string => typeNames.get(id) ?? 'Document';
  const relevant = library.document_types.filter(
    (t) => t.configurable || library.items.some((i) => i.document_type_id === t.id) || selections.some((s) => s.document_type_id === t.id),
  );
  const types: TypeRow[] = relevant.map((type) => {
    const tenantWide = selections.find((s) => s.document_type_id === type.id && s.client_id === null) ?? null;
    return {
      type,
      current: tenantWide === null ? null : (byId.get(tenantWide.template_id) ?? null),
      // A choice must be usable now: Aramo defaults (already filtered by the server) and
      // the organization's own APPROVED tenant-wide templates of this type.
      choices: library.items.filter(
        (i) => i.document_type_id === type.id && (i.owner_scope === 'PLATFORM' || (i.status === 'ACTIVE' && i.client_id === null)),
      ),
      clientChoices: selections
        .filter((s) => s.document_type_id === type.id && s.client_id !== null)
        .map((selection) => ({ selection, name: byId.get(selection.template_id)?.name ?? 'Template' })),
    };
  });
  return {
    types,
    defaults: library.items.filter((i) => i.owner_scope === 'PLATFORM'),
    own: library.items.filter((i) => i.owner_scope === 'TENANT'),
    typeName,
  };
}
