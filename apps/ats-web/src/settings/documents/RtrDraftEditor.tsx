import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, hasScope, Input, TextArea, useSession, useToast, type Session } from '@aramo/fe-foundation';

import {
  activateTemplateVersion,
  listAllowedBindings,
  listDocumentTemplates,
  listTemplateVersions,
  previewTemplateVersion,
  updateDraftVersion,
  DOC_TEMPLATE_MANAGE_SCOPE,
  RIGHT_TO_REPRESENT_TYPE_ID,
  RTR_GENERATED_SCHEMA_V1,
  type TemplateBinding,
  type TemplateVersionView,
} from './document-templates-api';
import {
  bindingMapFrom,
  buildFieldSchema,
  parseContent,
  parseLabelSegments,
  ChevronDown,
  PlusIcon,
  Segments,
  type BindingMap,
} from './dt-ui';
import { ApproveModal, PreviewModal, type PreviewContent } from './dt-modals';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11) — the Right-to-Represent DRAFT editor, styled to the
// approved prototype: a dedicated full-width page with a right rail and a sticky footer
// that carries the §18 approval gate. Fields are inserted ONLY from the governed catalog
// (GET allowed-bindings); typing an unrecognised [name] renders a red "unknown field"
// chip and blocks approval. The gate is server-authoritative (Save re-arms it; Preview
// records it; Approve re-validates) — the footer mirrors it for the admin.

const DETAIL_ROUTE = '/admin/settings/document-templates/rtr';
const LIST_ROUTE = '/admin/settings/document-templates';

interface Draft {
  versionId: string;
  n: number; // version number
  name: string;
  title: string;
  paras: string[]; // editable [Label] form
}

type LoadState =
  | { status: 'loading' }
  | { status: 'nodraft' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bindings: readonly TemplateBinding[]; map: BindingMap; activeVersion: number | null };

export function RtrDraftEditor({
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  listBindingsFn = listAllowedBindings,
  updateFn = updateDraftVersion,
  previewFn = previewTemplateVersion,
  activateFn = activateTemplateVersion,
}: {
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly listBindingsFn?: typeof listAllowedBindings;
  readonly updateFn?: typeof updateDraftVersion;
  readonly previewFn?: typeof previewTemplateVersion;
  readonly activateFn?: typeof activateTemplateVersion;
} = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useToast();
  const navigate = useNavigate();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewContent | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const focusIdx = useRef<number | null>(null);
  const selPos = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID) ?? null;
      if (rtr == null) { setLoad({ status: 'nodraft' }); return; }
      const [versions, bindings] = await Promise.all([listVersionsFn(rtr.id), listBindingsFn(rtr.id)]);
      const d = versions.find((v) => v.status === 'DRAFT');
      if (d == null) { setLoad({ status: 'nodraft' }); return; }
      const map = bindingMapFrom(bindings);
      const parsed = parseContent(d.field_schema, map);
      const active = versions.find((v) => v.id === rtr.current_version_id) ?? versions.find((v: TemplateVersionView) => v.status === 'ACTIVE');
      setDraft({ versionId: d.id, n: d.version_number, name: rtr.name, title: parsed.title, paras: parsed.paras.length > 0 ? parsed.paras : [''] });
      setDirty(false);
      setPreviewed(d.previewed_fingerprint != null && d.previewed_fingerprint === d.content_fingerprint);
      setLoad({ status: 'ready', bindings, map, activeVersion: active?.version_number ?? null });
    } catch (err) {
      setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load the draft.' });
    }
  }, [listTemplatesFn, listVersionsFn, listBindingsFn]);

  useEffect(() => { if (canManage) void refetch(); }, [canManage, refetch]);

  const map = load.status === 'ready' ? load.map : { labelByToken: {}, tokenByLabel: {} };

  function edited(next: Partial<Draft>) {
    setDraft((d) => (d != null ? { ...d, ...next } : d));
    setDirty(true);
    setPreviewed(false);
  }
  function editPara(i: number, text: string) { if (draft != null) edited({ paras: draft.paras.map((p, j) => (j === i ? text : p)) }); }
  function removePara(i: number) {
    if (draft == null) return;
    const paras = draft.paras.filter((_, j) => j !== i);
    edited({ paras: paras.length > 0 ? paras : [''] });
    setEditIdx(null);
  }
  function addPara() {
    if (draft == null) return;
    const paras = draft.paras.concat(['']);
    focusIdx.current = paras.length - 1; selPos.current = 0;
    edited({ paras });
    setEditIdx(paras.length - 1);
  }
  function insertField(label: string) {
    if (draft == null) return;
    const paras = draft.paras.slice();
    const tok = `[${label}]`;
    let idx = editIdx;
    if (idx == null) {
      idx = paras.length - 1;
      const p = paras[idx] ?? '';
      paras[idx] = p + (p !== '' && !/\s$/.test(p) ? ' ' : '') + tok;
    } else {
      const p = paras[idx] ?? '';
      const pos = selPos.current == null ? p.length : selPos.current;
      paras[idx] = p.slice(0, pos) + tok + p.slice(pos);
      selPos.current = pos + tok.length;
    }
    focusIdx.current = idx;
    edited({ paras });
    setInsertOpen(false);
    setEditIdx(idx);
  }

  async function save(): Promise<boolean> {
    if (draft == null) return false;
    setBusy(true);
    try {
      await updateFn(draft.versionId, { field_schema: buildFieldSchema(RTR_GENERATED_SCHEMA_V1, draft.title, draft.paras, map), render_schema_version: RTR_GENERATED_SCHEMA_V1 });
      setDirty(false); setPreviewed(false); setSavedAt('just now');
      toast.show('Draft saved.');
      return true;
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not save the draft.');
      return false;
    } finally { setBusy(false); }
  }
  async function runPreview() {
    if (draft == null) return;
    setEditIdx(null);
    if (dirty) { const ok = await save(); if (!ok) return; }
    setBusy(true);
    try {
      await previewFn(draft.versionId); // validates + records the §18 gate
      setPreviewed(true);
      setPreview({ label: `Draft · ${draft.name}`, title: draft.title, paras: draft.paras });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Preview failed. Check that every field is a supported one.');
    } finally { setBusy(false); }
  }
  async function approve() {
    if (draft == null) return;
    setBusy(true);
    try {
      await activateFn(draft.versionId);
      setApproveOpen(false);
      navigate(`${DETAIL_ROUTE}?activated=1`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not approve this version.');
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div className="dt-root">
        <div className="dt-noaccess">
          <div className="dt-noaccess__t">You don’t have permission to edit document templates</div>
          <div className="dt-noaccess__b">Ask a workspace admin for the document-template permission.</div>
        </div>
      </div>
    );
  }

  const crumb = (n: number | string) => (
    <div className="dt-crumb">
      <a onClick={() => navigate(LIST_ROUTE)}>Document templates</a><span>/</span>
      <a onClick={() => navigate(DETAIL_ROUTE)} data-testid="rtr-editor-back">Right to Represent</a><span>/</span>
      <span className="dt-crumb__cur">v{n} · Draft</span>
    </div>
  );

  if (load.status === 'loading') return <div className="dt-root"><div className="dt-editor"><p className="dt-note">Loading…</p></div></div>;
  if (load.status === 'error') return <div className="dt-root"><div className="dt-editor"><p className="dt-note" style={{ color: '#B3402A' }}>{load.message}</p></div></div>;
  if (load.status === 'nodraft' || draft == null) {
    return (
      <div className="dt-root">
        <div className="dt-editor dt-col">
          {crumb('—')}
          <div className="dt-card dt-pad">
            <div className="dt-cardtitle">There is no open draft to edit</div>
            <div className="dt-note">Start a new draft from the Right to Represent page.</div>
          </div>
        </div>
      </div>
    );
  }

  // Derived gate state (mirrors the backend §14/§18).
  const allSegs = draft.paras.map((p) => parseLabelSegments(p, map));
  const used: string[] = [];
  const bad: string[] = [];
  allSegs.forEach((ss) => ss.forEach((s) => {
    if (s.kind === 'field' && !used.includes(s.t)) used.push(s.t);
    if (s.kind === 'bad' && !bad.includes(s.t)) bad.push(s.t);
  }));
  const emptyDoc = draft.paras.every((p) => p.trim() === '');
  const blockReason = bad.length > 0 ? 'Remove unknown fields before approval' : emptyDoc ? 'Add content before approval' : !previewed ? 'Preview required before approval' : dirty ? 'Save and preview before approval' : '';
  const approveDisabled = blockReason !== '';
  const groups: Array<{ g: string; items: TemplateBinding[] }> = [];
  for (const b of load.bindings) {
    let g = groups.find((x) => x.g === b.group);
    if (g == null) { g = { g: b.group, items: [] }; groups.push(g); }
    g.items.push(b);
  }
  const draftN = draft.n;
  const saveState = dirty ? 'Unsaved changes' : savedAt != null ? `Draft saved · ${savedAt}` : 'Draft · not yet saved';

  return (
    <div className="dt-root">
      <div className="dt-editor">
        {crumb(draftN)}
        <div className="dt-edhead">
          <h1>Right to Represent · v{draftN}</h1>
          <span className="dt-pill dt-pill--draft"><span className="dt-pill__dot" />Draft</span>
          <span className="dt-edhead__based">
            Based on {load.activeVersion != null ? `v${load.activeVersion}` : 'the current version'} · not used by any workflow until approved
          </span>
          <span className="dt-edhead__save" style={{ color: dirty ? '#946011' : '#93A0A8' }}>{saveState}</span>
        </div>

        <div className="dt-edgrid">
          <div className="dt-card">
            <div className="dt-edfields">
              <label className="dt-lbl-wrap">
                <span className="dt-lbl">Template name</span>
                <Input unstyled className="dt-input" value={draft.name} onChange={(e) => edited({ name: e.target.value })} data-testid="rtr-editor-name" />
              </label>
              <label className="dt-lbl-wrap">
                <span className="dt-lbl">Document title</span>
                <Input unstyled className="dt-input" value={draft.title} onChange={(e) => edited({ title: e.target.value })} data-testid="rtr-editor-title" />
              </label>
            </div>

            <div className="dt-contentbar">
              <span className="dt-contentbar__lbl">CONTENT</span>
              <span className="dt-insert">
                <Button
                  unstyled
                  className={`dt-insert__btn${insertOpen ? ' dt-insert__btn--open' : ''}`}
                  onClick={() => setInsertOpen((o) => !o)}
                  data-testid="rtr-insert-field"
                >
                  <PlusIcon />Insert field<ChevronDown />
                </Button>
                {insertOpen ? (
                  <>
                    <span className="dt-insert__overlay" onClick={() => setInsertOpen(false)} />
                    <span className="dt-insert__menu">
                      <span className="dt-insert__hint">
                        {editIdx != null ? 'Inserts at the cursor in the paragraph you’re editing.' : 'Inserts at the end of the last paragraph. Click a paragraph first to place it.'}
                      </span>
                      {groups.map((g) => (
                        <span key={g.g}>
                          <span className="dt-insert__grp">{g.g}</span>
                          {g.items.map((it) => (
                            <Button unstyled key={it.key} className="dt-insert__item" onClick={() => insertField(it.label)} data-testid={`rtr-binding-${it.key}`}>
                              <span className="dt-chip">{it.label}</span>
                              {used.includes(it.label) ? <span className="dt-insert__used">in use</span> : null}
                            </Button>
                          ))}
                        </span>
                      ))}
                    </span>
                  </>
                ) : null}
              </span>
              <span className="dt-contentbar__hint">Write the legal wording freely. Only fields from the list can be inserted.</span>
            </div>

            <div className="dt-edbody">
              <div className="dt-edbody__title">{draft.title}</div>
              {draft.paras.map((raw, i) => {
                const editing = editIdx === i;
                return (
                  <div className="dt-pararow" key={i} data-testid={`rtr-para-${i}`}>
                    {editing ? (
                      <>
                        <TextArea
                          unstyled
                          className="dt-para__ta"
                          rows={3}
                          value={raw}
                          ref={(el) => {
                            if (el != null && focusIdx.current === i) {
                              focusIdx.current = null;
                              el.focus();
                              const p = selPos.current == null ? el.value.length : selPos.current;
                              try { el.setSelectionRange(p, p); } catch { /* noop */ }
                            }
                          }}
                          onChange={(e) => { selPos.current = e.target.selectionStart; editPara(i, e.target.value); }}
                          onSelect={(e) => { selPos.current = (e.target as HTMLTextAreaElement).selectionStart; }}
                          data-testid={`rtr-para-text-${i}`}
                        />
                        <div className="dt-para__hint">Fields show as [Field name] while editing. Click outside or Done to see chips.</div>
                      </>
                    ) : (
                      <div className="dt-para__read" title="Click to edit" onClick={() => { focusIdx.current = i; selPos.current = raw.length; setEditIdx(i); }}>
                        {raw.trim() === '' ? <span className="dt-para__empty">Empty paragraph — click to write</span> : <Segments text={raw} map={map} chipSize="md" />}
                      </div>
                    )}
                    <Button unstyled className="dt-para__rm" title="Remove paragraph" onClick={() => removePara(i)}>×</Button>
                  </div>
                );
              })}
              <div className="dt-edactions">
                <Button unstyled className="dt-addpara" onClick={addPara} data-testid="rtr-add-para">+ Add paragraph</Button>
                {editIdx != null ? <Button unstyled className="dt-donepara" onClick={() => setEditIdx(null)}>Done</Button> : null}
              </div>
            </div>
          </div>

          <div className="dt-rail">
            <div className="dt-railcard">
              <div className="dt-railcard__t">Fields in this draft</div>
              {used.map((l) => (
                <div className="dt-railfield" key={l}>
                  <span className="dt-chip">{l}</span>
                  <span className="dt-railfield__grp">{map.tokenByLabel[l] != null ? (load.bindings.find((b) => b.label === l)?.group ?? '') : ''}</span>
                </div>
              ))}
              {used.length === 0 ? <div className="dt-rail__none">No fields yet.</div> : null}
              {bad.length > 0 ? <div className="dt-rail__bad">{bad.length} unknown field{bad.length > 1 ? 's' : ''} — remove before approval.</div> : null}
            </div>
            <div className="dt-railcard">
              <div className="dt-railcard__t">What approval does</div>
              <div className="dt-rail__body">Approving makes this the version every new RTR uses. Recruiters can't choose another template. RTRs already sent stay on their original version.</div>
            </div>
          </div>
        </div>
      </div>

      <div className="dt-footer">
        <span className={`dt-footer__note ${blockReason !== '' ? 'dt-footer__note--block' : 'dt-footer__note--ok'}`}>{blockReason !== '' ? blockReason : '✓ Previewed · ready to approve'}</span>
        <span className="dt-footer__acts">
          <Button unstyled className="dt-btn dt-btn--neutral" onClick={() => void runPreview()} disabled={busy} data-testid="rtr-editor-preview">Preview</Button>
          <Button unstyled className="dt-btn dt-btn--neutral" onClick={() => void save()} disabled={busy || !dirty} data-testid="rtr-editor-save">Save draft</Button>
          <Button
            unstyled
            className={`dt-btn ${approveDisabled ? 'dt-btn--disabled' : 'dt-btn--primary'}`}
            onClick={() => { if (!approveDisabled) setApproveOpen(true); }}
            disabled={approveDisabled || busy}
            title={blockReason !== '' ? blockReason : 'Approve and make this the active version'}
            data-testid="rtr-editor-approve"
          >
            Approve &amp; activate
          </Button>
        </span>
      </div>

      {preview != null ? <PreviewModal content={preview} map={map} onClose={() => setPreview(null)} /> : null}
      {approveOpen ? (
        <ApproveModal
          draftVersion={draftN}
          activeVersion={load.activeVersion}
          busy={busy}
          onCancel={() => setApproveOpen(false)}
          onApprove={() => void approve()}
        />
      ) : null}
    </div>
  );
}
