import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, hasScope, Input, TextArea, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { resolveUserNames } from '../../users/users-api';
import { safeErrorMessage } from '../../ui';

import {
  activateTemplateVersion,
  deleteDraftVersion,
  listAllowedBindings,
  listDocumentTemplates,
  listTemplateVersions,
  previewTemplateVersion,
  updateDocumentTemplate,
  updateDraftVersion,
  DOC_TEMPLATE_MANAGE_SCOPE,
  RIGHT_TO_REPRESENT_TYPE_ID,
  RTR_GENERATED_SCHEMA_V1,
  type TemplateBinding,
  type TemplateSamplePreview,
  type TemplateVersionView,
} from './document-templates-api';
import {
  bindingMapFrom,
  buildFieldSchema,
  fmtDate,
  groupBindings,
  parseContent,
  parseLabelSegments,
  signatureFrom,
  tokensToLabels,
  CheckCircleIcon,
  ChevronDown,
  ClockIcon,
  CloudIcon,
  DocOutline,
  DragDots,
  EyeIcon,
  LockIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SignatureBlock,
  SourceIcon,
  TabIcon,
  JOB_DESCRIPTION_KEY,
  TALENT_NAME_KEY,
  type BindingMap,
  type Block,
} from './dt-ui';
import { BlockBox, insertAtRange, makeFieldChip, TEXT_TOKEN_CODEC } from './dt-block-editor';
import { ApproveModal, DiscardModal, PreviewModal, PreviewPaper, type PreviewContent } from './dt-modals';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11) + PO §9 "Draft editor v2" — the Right-to-Represent DRAFT
// editor, styled to the approved prototype (Document Templates.dc.html #rtr/draft/example):
// template details, a tabbed builder (Document builder · Preview · Versions · Settings),
// a right rail (fields in this draft · approval checklist · version history) and a sticky
// one-row footer that carries the approval gate. Fields come ONLY from the governed catalog
// (GET allowed-bindings); an unknown field renders a red chip and blocks approval. The
// gate is server-authoritative (Save re-arms it; Preview records it; Approve re-validates)
// — the derived checklist mirrors it. Only controls the v1 content model can persist are
// rendered (Heading toggle) — no dead formatting controls.

const DETAIL_ROUTE = '/admin/settings/document-templates/rtr';
const LIST_ROUTE = '/admin/settings/document-templates';

type Tab = 'builder' | 'preview' | 'versions' | 'settings';
interface EdBlock extends Block { readonly id: string }

interface Draft {
  templateId: string;
  versionId: string;
  n: number;
  name: string;
  savedName: string;
  title: string;
  blocks: EdBlock[];
  notes: string | null; // null = the server's version view has no internal_notes property
  savedNotes: string | null;
  createdBy: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'nodraft' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      bindings: readonly TemplateBinding[];
      map: BindingMap;
      versions: readonly TemplateVersionView[];
      active: TemplateVersionView | null;
      names: Record<string, string>;
    };

type InlinePreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; content: PreviewContent };

// The 4 standard RTR clauses (prototype wording). Each is offered ONLY when every field it
// uses is in the governed catalog — so "Agreed pay rate" is hidden while agreed pay has no
// authoritative binding.
const CLAUSES: ReadonlyArray<{ id: string; name: string; text: string }> = [
  { id: 'withdrawal', name: 'Withdrawal', text: 'This authorization may be withdrawn by the talent in writing at any time before the talent is presented to the client.' },
  { id: 'scope', name: 'Scope limit', text: 'This authorization applies only to the client and requisition identified above.' },
  { id: 'pay', name: 'Agreed pay rate', text: 'The agreed pay rate for this opportunity is {{agreed_pay_rate.amount}} {{agreed_pay_rate.currency}} per {{agreed_pay_rate.period}}.' },
  {
    id: 'representation',
    name: 'Representation',
    text: 'I authorize {{recruiting_company.name}} to represent me, {{talent.full_name}}, to {{client.name}} for the {{requisition.title}} opportunity ({{requisition.reference}}).',
  },
];
const TOKEN_KEYS_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
function clauseKeys(text: string): string[] { return Array.from(text.matchAll(TOKEN_KEYS_RE)).map((m) => m[1] ?? ''); }

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: string }> = [
  { id: 'builder', label: 'Document builder', icon: 'M4 5h16M4 10h16M4 15h10M4 20h7' },
  { id: 'preview', label: 'Preview', icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { id: 'versions', label: 'Versions', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2' },
  { id: 'settings', label: 'Settings', icon: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1' },
];

const SETTINGS_FACTS: ReadonlyArray<{ l: string; v: string; s: string }> = [
  { l: 'DOCUMENT TYPE', v: 'Right to Represent', s: 'Governed document type' },
  { l: 'SCOPE', v: 'Tenant default', s: 'Client-specific templates may come later' },
  { l: 'USED BY', v: 'Requisition → Talent → Send RTR', s: 'Recruiters can’t choose another template' },
  { l: 'SIGNER', v: 'Talent', s: 'Recipient is locked to the talent’s email' },
  { l: 'SIGNING', v: 'Aramo e-sign', s: 'Frozen from this version when sent' },
  { l: 'SIGNATURE PLACEMENT', v: 'End of document (fixed)', s: 'Talent signature · printed name · date signed' },
  { l: 'ALLOWED CONTENT', v: 'Headings and paragraphs with governed fields', s: 'Fields come from the governed catalog only' },
];

let blockSeq = 0;
const newBlockId = (): string => `b${++blockSeq}`;

function pillClass(status: string): string {
  return status === 'ACTIVE' ? 'dt-pill--active' : status === 'DRAFT' ? 'dt-pill--draft' : 'dt-pill--retired';
}
function pillLabel(status: string): string {
  return status === 'ACTIVE' ? 'Active' : status === 'DRAFT' ? 'Draft' : 'Retired';
}
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0] ?? ''} ${(parts[parts.length - 1] ?? '').charAt(0)}.`;
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// A small popover menu: keyboard reachable (Buttons), Escape closes, click-away overlay.
function Menu({ open, onClose, className, children, label }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly className: string;
  readonly children: ReactNode;
  readonly label: string;
}) {
  if (!open) return null;
  return (
    <>
      <span className="dt-insert__overlay" onClick={onClose} />
      <span
        className={className}
        role="menu"
        aria-label={label}
        onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      >
        {children}
      </span>
    </>
  );
}

export function RtrDraftEditor({
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  listBindingsFn = listAllowedBindings,
  resolveNamesFn = resolveUserNames,
  updateFn = updateDraftVersion,
  renameFn = updateDocumentTemplate,
  previewFn = previewTemplateVersion,
  activateFn = activateTemplateVersion,
  discardFn = deleteDraftVersion,
}: {
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly listBindingsFn?: typeof listAllowedBindings;
  readonly resolveNamesFn?: typeof resolveUserNames;
  readonly updateFn?: typeof updateDraftVersion;
  readonly renameFn?: typeof updateDocumentTemplate;
  readonly previewFn?: typeof previewTemplateVersion;
  readonly activateFn?: typeof activateTemplateVersion;
  readonly discardFn?: typeof deleteDraftVersion;
} = {}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const toast = useToast();
  const navigate = useNavigate();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nameDirty, setNameDirty] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('builder');
  const [inline, setInline] = useState<InlinePreview>({ status: 'idle' });
  const [modal, setModal] = useState<PreviewContent | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [clauseOpen, setClauseOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [blockMenu, setBlockMenu] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [fq, setFq] = useState('');
  const [shut, setShut] = useState<Record<string, boolean>>({});

  const els = useRef<Record<string, HTMLDivElement | null>>({});
  const selRef = useRef<{ id: string; range: Range | null } | null>(null);
  const dragRef = useRef<string | null>(null);
  const focusNext = useRef<string | null>(null);

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
      const active = versions.find((v) => v.id === rtr.current_version_id) ?? versions.find((v) => v.status === 'ACTIVE') ?? null;
      const hasNotes = Object.prototype.hasOwnProperty.call(d, 'internal_notes');
      const notes = hasNotes ? (d.internal_notes ?? '') : null;
      const ids = [...new Set(versions.flatMap((v) => [v.activated_by, v.created_by]).filter((x): x is string => x != null))];
      let names: Record<string, string> = {};
      try { names = await resolveNamesFn(ids); } catch { names = {}; }
      const blocks = parsed.blocks.length > 0 ? parsed.blocks : [{ type: 'TEXT' as const, text: '' }];
      setDraft({
        templateId: rtr.id, versionId: d.id, n: d.version_number, name: rtr.name, savedName: rtr.name,
        title: parsed.title, blocks: blocks.map((b) => ({ ...b, id: newBlockId() })),
        notes, savedNotes: notes, createdBy: d.created_by,
      });
      setNameDirty(false);
      setContentDirty(false);
      setPreviewed(d.previewed_fingerprint != null && d.previewed_fingerprint === d.content_fingerprint);
      setLoad({ status: 'ready', bindings, map, versions, active, names: names ?? {} });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load the draft.') });
    }
  }, [listTemplatesFn, listVersionsFn, listBindingsFn, resolveNamesFn]);

  useEffect(() => { if (canManage) void refetch(); }, [canManage, refetch]);

  // Focus a just-added block and put the caret at its end.
  useEffect(() => {
    const id = focusNext.current;
    if (id == null) return;
    const el = els.current[id];
    if (el == null) return;
    focusNext.current = null;
    el.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      selRef.current = { id, range: r.cloneRange() };
    } catch { /* selection API unavailable */ }
  });

  const map: BindingMap = load.status === 'ready' ? load.map : { labelByToken: {}, tokenByLabel: {} };
  const registerEl = useCallback((id: string, el: HTMLDivElement | null) => { els.current[id] = el; }, []);

  function editContent(next: Partial<Draft>) {
    setDraft((d) => (d != null ? { ...d, ...next } : d));
    setContentDirty(true);
    setPreviewed(false);
    setSaveError(null);
  }
  function setBlocks(blocks: EdBlock[]) { editContent({ blocks }); }
  const onBlockChange = useCallback((id: string, text: string) => {
    setDraft((d) => {
      if (d == null) return d;
      const cur = d.blocks.find((b) => b.id === id);
      if (cur == null || cur.text === text) return d;
      setContentDirty(true);
      setPreviewed(false);
      setSaveError(null);
      return { ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, text } : b)) };
    });
  }, []);
  const onBlockSelect = useCallback((id: string, range: Range | null) => {
    setActiveId(id);
    selRef.current = { id, range };
  }, []);

  function addBlockAfter(afterId: string | null, block: Block) {
    if (draft == null) return;
    const blocks = draft.blocks.slice();
    const i = afterId != null ? blocks.findIndex((b) => b.id === afterId) : -1;
    const nb: EdBlock = { ...block, id: newBlockId() };
    blocks.splice(i >= 0 ? i + 1 : blocks.length, 0, nb);
    focusNext.current = nb.id;
    setActiveId(nb.id);
    selRef.current = { id: nb.id, range: null };
    setBlocks(blocks);
  }
  function moveBlock(id: string, to: number) {
    if (draft == null) return;
    const blocks = draft.blocks.slice();
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) return;
    const [m] = blocks.splice(i, 1);
    if (m == null) return;
    blocks.splice(Math.max(0, Math.min(to, blocks.length)), 0, m);
    setBlocks(blocks);
  }
  function dropBefore(dragId: string, targetId: string | 'end') {
    if (draft == null || dragId === targetId) return;
    const rest = draft.blocks.filter((b) => b.id !== dragId);
    const m = draft.blocks.find((b) => b.id === dragId);
    if (m == null) return;
    const j = targetId === 'end' ? rest.length : rest.findIndex((b) => b.id === targetId);
    rest.splice(j < 0 ? rest.length : j, 0, m);
    setBlocks(rest);
  }
  function deleteBlock(id: string) {
    if (draft == null) return;
    const rest = draft.blocks.filter((b) => b.id !== id);
    // The last remaining block can't be removed — it resets to an empty paragraph.
    setBlocks(rest.length > 0 ? rest : [{ id: newBlockId(), type: 'TEXT', text: '' }]);
    if (activeId === id) setActiveId(null);
  }
  function duplicateBlock(id: string) {
    const b = draft?.blocks.find((x) => x.id === id);
    if (b != null) addBlockAfter(id, { type: b.type, text: b.text });
  }
  function toggleHeading() {
    if (draft == null || activeId == null) return;
    setBlocks(draft.blocks.map((b) => (b.id === activeId ? { ...b, type: b.type === 'HEADING' ? 'TEXT' : 'HEADING' } : b)));
  }

  function insertField(key: string) {
    if (draft == null) return;
    const label = map.labelByToken[key];
    setInsertOpen(false);
    if (label == null) return;
    if (key === JOB_DESCRIPTION_KEY) { addBlockAfter(activeId, { type: 'TEXT', text: `[${label}]` }); return; }
    const sel = selRef.current;
    const id = activeId != null && draft.blocks.some((b) => b.id === activeId) ? activeId : null;
    const el = id != null ? els.current[id] : null;
    if (id != null && el != null && sel != null && sel.id === id && sel.range != null && el.contains(sel.range.startContainer)) {
      // At the caret in the focused block: insert an atomic chip node, then re-serialise.
      insertAtRange(el, sel.range, [makeFieldChip(key, label), document.createTextNode(' ')]);
      try { const s = window.getSelection(); if (s != null && s.rangeCount > 0) selRef.current = { id, range: s.getRangeAt(0).cloneRange() }; } catch { /* noop */ }
      onBlockChange(id, TEXT_TOKEN_CODEC.serialize(el, map));
      return;
    }
    // Otherwise: at the end of the last block.
    const last = draft.blocks[draft.blocks.length - 1];
    if (last == null) return;
    const sep = last.text !== '' && !/\s$/.test(last.text) ? ' ' : '';
    setBlocks(draft.blocks.map((b) => (b.id === last.id ? { ...b, text: `${b.text}${sep}[${label}]` } : b)));
  }
  function addClause(text: string) {
    setClauseOpen(false);
    addBlockAfter(activeId, { type: 'TEXT', text: tokensToLabels(text, map) });
  }

  async function saveName(d: Draft): Promise<boolean> {
    const name = d.name.trim();
    if (name === d.savedName) return true;
    if (name === '') { setSaveError('Template name is required.'); toast.show('Template name is required.'); return false; }
    const t = await renameFn(d.templateId, { name });
    setDraft((cur) => (cur != null ? { ...cur, name: t.name, savedName: t.name } : cur));
    setNameDirty(false);
    return true;
  }

  async function save(): Promise<boolean> {
    if (draft == null) return false;
    setBusy(true);
    setSaveError(null);
    try {
      if (!(await saveName(draft))) return false;
      const input: { field_schema: unknown; render_schema_version: string; internal_notes?: string | null } = {
        field_schema: buildFieldSchema(RTR_GENERATED_SCHEMA_V1, draft.title, draft.blocks, map),
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
      };
      if (draft.notes !== null && draft.notes !== draft.savedNotes) input.internal_notes = draft.notes;
      const res = await updateFn(draft.versionId, input);
      setNameDirty(false);
      setContentDirty(false);
      // The server re-arms (or keeps) the §18 gate — trust its markers.
      setPreviewed(res != null && res.previewed_fingerprint != null && res.previewed_fingerprint === res.content_fingerprint);
      const savedNotes = draft.notes;
      setDraft((cur) => (cur != null ? { ...cur, savedNotes } : cur));
      setSavedAt(new Date());
      toast.show('Draft saved.');
      return true;
    } catch (err) {
      const msg = safeErrorMessage(err, 'Could not save the draft.');
      setSaveError(msg);
      toast.show(msg);
      return false;
    } finally { setBusy(false); }
  }

  async function fetchPreview(d: Draft): Promise<PreviewContent | null> {
    if (nameDirty || contentDirty) { const ok = await save(); if (!ok) return null; }
    setBusy(true);
    try {
      // The SERVER's fixed-sample render (validates + records the §18 gate), shown as
      // returned — the FE substitutes no sample values of its own.
      const res: TemplateSamplePreview = await previewFn(d.versionId);
      setPreviewed(true);
      return { label: `Draft v${d.n} · ${d.name}`, mode: 'sample', title: res.title, blocks: res.blocks, signature: signatureFrom(res) };
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Preview failed. Check that every field is a supported one.'));
      return null;
    } finally { setBusy(false); }
  }
  async function openPreviewTab() {
    if (draft == null) return;
    setTab('preview');
    setMoreOpen(false);
    setInline({ status: 'loading' });
    const c = await fetchPreview(draft);
    setInline(c != null ? { status: 'ready', content: c } : { status: 'error', message: 'Preview failed. Save the draft and check that every field is a supported one.' });
  }
  async function openPreviewModal() {
    if (draft == null) return;
    const c = await fetchPreview(draft);
    if (c != null) setModal(c);
  }
  function viewVersion(v: TemplateVersionView) {
    const c = parseContent(v.field_schema, map);
    setModal({
      label: `v${v.version_number} · ${draft?.name ?? ''} · ${pillLabel(v.status)}`,
      mode: 'content',
      title: c.title,
      blocks: c.blocks,
      signature: signatureFrom(v),
    });
  }
  function selectTab(t: Tab) {
    if (t === 'preview') { void openPreviewTab(); return; }
    setTab(t);
  }

  async function approve() {
    if (draft == null) return;
    setBusy(true);
    try {
      if (!(await saveName(draft))) { setBusy(false); return; }
      await activateFn(draft.versionId);
      setApproveOpen(false);
      navigate(`${DETAIL_ROUTE}?activated=1`);
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not approve this version.'));
      setBusy(false);
    }
  }
  async function discard() {
    if (draft == null) return;
    setBusy(true);
    try {
      await discardFn(draft.versionId);
      setDiscardOpen(false);
      toast.show(`Draft v${draft.n} discarded. The active version is unchanged.`);
      navigate(DETAIL_ROUTE);
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not discard this draft.'));
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div className="dt-root">
        <div className="set-content">
          <div className="dt-noaccess">
            <div className="dt-noaccess__t">You don’t have permission to edit document templates</div>
            <div className="dt-noaccess__b">Ask a workspace admin for the document-template permission.</div>
          </div>
        </div>
      </div>
    );
  }

  const crumb = (n: number | string) => (
    <div className="dt-crumb">
      <a onClick={() => navigate(LIST_ROUTE)}>Document templates</a><span>/</span>
      <a onClick={() => navigate(DETAIL_ROUTE)} data-testid="rtr-editor-back">Right to Represent</a><span>/</span>
      <span className="dt-crumb__cur">v{n}</span>
    </div>
  );

  if (load.status === 'loading') return <div className="dt-root"><div className="set-content"><div className="dt-editor"><p className="dt-note">Loading…</p></div></div></div>;
  if (load.status === 'error') return <div className="dt-root"><div className="set-content"><div className="dt-editor"><p className="dt-note" style={{ color: '#B3402A' }}>{load.message}</p></div></div></div>;
  if (load.status === 'nodraft' || draft == null) {
    return (
      <div className="dt-root">
        <div className="set-content">
          <div className="dt-editor dt-col">
            {crumb('—')}
            <div className="dt-card dt-pad">
              <div className="dt-cardtitle">There is no open draft to edit</div>
              <div className="dt-note">Start a new draft from the Right to Represent page.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Derived state (mirrors the backend §14/§18 gate) ──
  const usedKeys: string[] = [];
  const bad: string[] = [];
  for (const b of [draft.title, ...draft.blocks.map((x) => x.text)]) {
    for (const s of parseLabelSegments(b, map)) {
      if (s.kind === 'field') { const k = map.tokenByLabel[s.t]; if (k != null && !usedKeys.includes(k)) usedKeys.push(k); }
      if (s.kind === 'bad' && !bad.includes(s.t)) bad.push(s.t);
    }
  }
  const nameOk = draft.name.trim() !== '';
  const titleOk = draft.title.trim() !== '';
  const emptyDoc = draft.blocks.every((b) => b.text.trim() === '');
  const talentLabel = map.labelByToken[TALENT_NAME_KEY] ?? 'Talent full name';
  const isPreviewed = previewed && !contentDirty;
  const checklist: ReadonlyArray<{ label: string; ok: boolean; reason: string }> = [
    { label: 'Template name and document title provided', ok: nameOk && titleOk, reason: 'Add a template name and document title' },
    { label: 'Document content added', ok: !emptyDoc, reason: 'Add content before approval' },
    { label: `Required field included · ${talentLabel}`, ok: usedKeys.includes(TALENT_NAME_KEY), reason: `Insert ${talentLabel} — an RTR must name the talent` },
    { label: 'Only governed fields used', ok: bad.length === 0, reason: 'Remove unknown fields before approval' },
    { label: 'Previewed with sample data', ok: isPreviewed, reason: 'Preview required before approval' },
  ];
  const unmet = checklist.find((c) => !c.ok);
  const blockReason = unmet != null ? unmet.reason : '';
  const approveDisabled = blockReason !== '';
  const ckDone = checklist.filter((c) => c.ok).length;
  const dirty = nameDirty || contentDirty;

  const groups = groupBindings(load.bindings);
  const allowed = new Set(load.bindings.map((b) => b.key));
  const clauses = CLAUSES.filter((c) => clauseKeys(c.text).every((k) => allowed.has(k)));
  const jdLabel = map.labelByToken[JOB_DESCRIPTION_KEY];
  const activeBlock = draft.blocks.find((b) => b.id === activeId) ?? null;

  const activeN = load.active?.version_number ?? null;
  const nonDraft = load.versions.filter((v) => v.status !== 'DRAFT').slice().sort((a, b) => b.version_number - a.version_number);
  const draftRow = load.versions.find((v) => v.id === draft.versionId);
  const verAll = (draftRow != null ? [draftRow] : []).concat(nonDraft);
  const nameOf = (id: string | null): string => (id != null ? load.names[id] ?? '' : '');
  const whenOf = (v: TemplateVersionView): string => {
    if (v.status === 'DRAFT') return `This draft · based on ${activeN != null ? `v${activeN}` : 'the current version'}`;
    if (v.activated_at != null) { const by = nameOf(v.activated_by); return `Approved ${fmtDate(v.activated_at)}${by !== '' ? ` · ${by}` : ''}`; }
    return `Initial system version · ${fmtDate(v.created_at)}`;
  };

  const saveState = saveError != null ? `Not saved · ${saveError}` : dirty ? 'Unsaved changes' : savedAt != null ? `Draft saved · ${fmtTime(savedAt)}` : 'No changes yet';
  const saveCls = saveError != null ? 'dt-save--err' : dirty ? 'dt-save--dirty' : 'dt-save--ok';

  const q = fq.trim().toLowerCase();
  const railGroups = groups
    .map((g) => ({ ...g, shown: g.items.filter((it) => q === '' || it.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) }))
    .filter((g) => g.shown.length > 0);

  let pn = 0;
  const blockLabel = (b: EdBlock): string => {
    if (b.type === 'HEADING') return 'Heading';
    if (jdLabel != null && b.text.trim() === `[${jdLabel}]`) return 'Job description';
    pn += 1;
    return `Paragraph ${pn}`;
  };

  const rowDragOver = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    if (dragRef.current == null) return;
    e.preventDefault();
    if (dragOver !== id) setDragOver(id);
  };
  const rowDrop = (id: string | 'end') => (e: DragEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (d == null) return;
    e.preventDefault();
    dragRef.current = null;
    setDragOver(null);
    dropBefore(d, id);
  };

  return (
    <div className="dt-root">
      <div className="set-content" data-testid="rtr-editor-page">
        <div className="dt-editor dt-ed2">
          {crumb(draft.n)}
          <div className="dt-ed2head" data-testid="rtr-editor-header">
            <h1>Right to Represent · v{draft.n}</h1>
            <span className="dt-pill dt-pill--draft"><span className="dt-pill__dot" />Draft</span>
            <span className={`dt-ed2head__save ${saveCls}`} role={saveError != null ? 'alert' : undefined} data-testid="rtr-editor-save-state">
              <CloudIcon />{saveState}
            </span>
            <span className="dt-rel">
              <Button unstyled className="dt-more" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} data-testid="rtr-editor-more">···</Button>
              <Menu open={moreOpen} onClose={() => setMoreOpen(false)} className="dt-menu dt-menu--right" label="More actions">
                <Button unstyled role="menuitem" className="dt-menu__item" onClick={() => void openPreviewTab()} data-testid="rtr-more-preview">Preview with sample data</Button>
                {load.active != null ? (
                  <Button unstyled role="menuitem" className="dt-menu__item" onClick={() => { setMoreOpen(false); if (load.active != null) viewVersion(load.active); }} data-testid="rtr-more-view-active">
                    View active v{load.active.version_number} (read-only)
                  </Button>
                ) : null}
                <Button unstyled role="menuitem" className="dt-menu__item" onClick={() => navigate(DETAIL_ROUTE)}>Back to Right to Represent</Button>
                <Button unstyled role="menuitem" className="dt-menu__item dt-menu__item--danger" onClick={() => { setMoreOpen(false); setDiscardOpen(true); }}>Discard draft</Button>
              </Menu>
            </span>
          </div>
          <div className="dt-ed2based">
            Based on <b>{activeN != null ? `v${activeN}` : 'the current version'}</b> · not used by any workflow until approved
          </div>

          <div className="dt-ed2grid">
            <div className="dt-ed2main">
              {/* Template details */}
              <div className="dt-card dt-ed2card dt-ed2details" data-testid="rtr-template-details">
                <div className="dt-ed2cardhead">
                  <span className="dt-ed2cardhead__ic"><DocOutline /></span>
                  <span><span className="dt-ed2cardhead__t">Template details</span><span className="dt-ed2cardhead__s">Set the basics for this document template.</span></span>
                </div>
                <div className="dt-ed2fields">
                  <label className="dt-lbl-wrap">
                    <span className="dt-lbl">Template name <span className="dt-req">*</span></span>
                    <Input unstyled className={`dt-input${nameOk ? '' : ' dt-input--req'}`} value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setNameDirty(true); setSaveError(null); }} data-testid="rtr-editor-name" />
                    <span className="dt-help">Shown to admins and in the recruiter's send panel.</span>
                  </label>
                  <label className="dt-lbl-wrap">
                    <span className="dt-lbl">Document title <span className="dt-req">*</span></span>
                    <Input unstyled className={`dt-input${titleOk ? '' : ' dt-input--req'}`} value={draft.title} onChange={(e) => editContent({ title: e.target.value })} data-testid="rtr-editor-title" />
                    <span className="dt-help">Printed at the top of the document.</span>
                  </label>
                  {draft.notes !== null ? (
                    <label className="dt-lbl-wrap">
                      <span className="dt-lbl">Internal notes / usage guidance</span>
                      <TextArea
                        unstyled
                        className="dt-input dt-input--notes"
                        rows={2}
                        maxLength={500}
                        placeholder="For admins only — never appears in the document"
                        value={draft.notes}
                        onChange={(e) => editContent({ notes: e.target.value.slice(0, 500) })}
                        data-testid="rtr-editor-notes"
                      />
                      <span className="dt-help dt-help--count">{draft.notes.length}/500</span>
                    </label>
                  ) : null}
                </div>
              </div>

              {/* Tabs */}
              <div className="dt-card dt-ed2tabs" role="tablist" aria-label="Draft sections">
                {TABS.map((t) => (
                  <Button
                    unstyled
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`dt-ed2tab${tab === t.id ? ' dt-ed2tab--on' : ''}`}
                    onClick={() => selectTab(t.id)}
                    data-testid={`rtr-tab-${t.id}`}
                  >
                    <TabIcon path={t.icon} />{t.label}
                    {t.id === 'preview' && !isPreviewed ? <span className="dt-ed2tab__dot" title="Preview required before approval" data-testid="rtr-preview-dot" /> : null}
                  </Button>
                ))}
              </div>

              {tab === 'builder' ? (
                <div className="dt-card dt-ed2card--flush" role="tabpanel" data-testid="rtr-panel-builder">
                  <div className="dt-ed2bhead">
                    <span className="dt-ed2cardhead__ic"><DocOutline /></span>
                    <span className="dt-ed2bhead__txt"><span className="dt-ed2cardhead__t">Document content</span><span className="dt-ed2cardhead__s">Build the template using editable content and merge fields.</span></span>
                    <span className="dt-ed2bhead__acts">
                      <span className="dt-rel">
                        <Button
                          unstyled
                          className={`dt-obtn${insertOpen ? ' dt-obtn--open' : ''}`}
                          aria-haspopup="menu"
                          aria-expanded={insertOpen}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setInsertOpen((o) => !o); setClauseOpen(false); }}
                          data-testid="rtr-insert-field"
                        >
                          <PlusIcon />Insert field<ChevronDown />
                        </Button>
                        <Menu open={insertOpen} onClose={() => setInsertOpen(false)} className="dt-menu dt-menu--right dt-menu--fields" label="Insert field">
                          <span className="dt-insert__hint">
                            {activeId != null ? 'Inserts at the cursor. Fields are filled in when the RTR is sent.' : 'Inserts at the end of the last paragraph. Click a paragraph first to place it.'}
                          </span>
                          {groups.map((g) => (
                            <span key={g.id} data-testid={`rtr-insert-group-${g.id}`}>
                              <span className="dt-insert__grp">{g.label}</span>
                              {g.items.map((it) => (
                                <Button unstyled role="menuitem" key={it.key} className="dt-insert__item" onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(it.key)} data-testid={`rtr-binding-${it.key}`}>
                                  <span className="dt-chip"><SourceIcon source={g.source} size={12} />{it.key === JOB_DESCRIPTION_KEY ? 'Job description' : it.label}</span>
                                  {it.key === JOB_DESCRIPTION_KEY ? <span className="dt-insert__used">own paragraph</span> : null}
                                  {usedKeys.includes(it.key) ? <span className="dt-insert__used dt-ml-auto">in use</span> : null}
                                </Button>
                              ))}
                            </span>
                          ))}
                        </Menu>
                      </span>
                      <span className="dt-rel">
                        <Button unstyled className="dt-obtn" aria-haspopup="menu" aria-expanded={clauseOpen} onMouseDown={(e) => e.preventDefault()} onClick={() => { setClauseOpen((o) => !o); setInsertOpen(false); }} data-testid="rtr-add-clause">
                          <DocOutline size={13} />Add clause
                        </Button>
                        <Menu open={clauseOpen} onClose={() => setClauseOpen(false)} className="dt-menu dt-menu--right dt-menu--clauses" label="Add clause">
                          <span className="dt-insert__hint">Standard clauses · inserted as an editable paragraph after the cursor</span>
                          {clauses.map((c) => (
                            <Button unstyled role="menuitem" key={c.id} className="dt-clause" onMouseDown={(e) => e.preventDefault()} onClick={() => addClause(c.text)} data-testid={`rtr-clause-${c.id}`}>
                              <span className="dt-clause__n">{c.name}</span>
                              <span className="dt-clause__t">{c.text.replace(TOKEN_KEYS_RE, (_w, k: string) => `‹${map.labelByToken[k] ?? k}›`)}</span>
                            </Button>
                          ))}
                        </Menu>
                      </span>
                      <Button unstyled className="dt-obtn" onClick={() => addBlockAfter(activeId, { type: 'TEXT', text: '' })} data-testid="rtr-add-para-top">
                        <PlusIcon />Add paragraph
                      </Button>
                    </span>
                  </div>
                  <div className="dt-ed2format">
                    <span className="dt-ed2format__l">FORMAT</span>
                    <span className="dt-ed2tools">
                      <Button
                        unstyled
                        className={`dt-ed2tool${activeBlock?.type === 'HEADING' ? ' dt-ed2tool--on' : ''}`}
                        title={activeBlock != null ? 'Section heading' : 'Click a paragraph first'}
                        aria-label="Section heading"
                        aria-pressed={activeBlock?.type === 'HEADING'}
                        disabled={activeBlock == null}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={toggleHeading}
                        data-testid="rtr-format-heading"
                      >
                        H
                      </Button>
                    </span>
                    <span className="dt-ed2format__hint">Click × on a field to remove it · drag ⋮⋮ to reorder</span>
                  </div>
                  <div className="dt-ed2rows">
                    <div className="dt-ed2row dt-ed2row--center">
                      <span />
                      <span className="dt-ed2pill">Title</span>
                      <div className="dt-ed2title" data-testid="rtr-builder-title">{draft.title}</div>
                      <span />
                    </div>
                    {draft.blocks.map((block, i) => {
                      const heading = block.type === 'HEADING';
                      const label = blockLabel(block);
                      const open = blockMenu === block.id;
                      return (
                        <div
                          key={block.id}
                          className={`dt-ed2row${dragOver === block.id ? ' dt-ed2row--drop' : ''}`}
                          data-testid={`rtr-para-${i}`}
                          data-block-type={block.type}
                          onDragOver={rowDragOver(block.id)}
                          onDrop={rowDrop(block.id)}
                        >
                          <span
                            className="dt-ed2handle"
                            draggable
                            title="Drag to reorder"
                            aria-hidden="true"
                            data-testid={`rtr-drag-${i}`}
                            onDragStart={(e) => {
                              dragRef.current = block.id;
                              try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-aramo-block', block.id); } catch { /* jsdom */ }
                            }}
                            onDragEnd={() => { dragRef.current = null; setDragOver(null); }}
                          >
                            <DragDots />
                          </span>
                          <span className="dt-ed2pill dt-ed2pill--blk" data-testid={`rtr-para-label-${i}`}>{label}</span>
                          <BlockBox
                            blockId={block.id}
                            text={block.text}
                            heading={heading}
                            map={map}
                            placeholder={heading ? 'Heading' : label}
                            testId={`rtr-para-text-${i}`}
                            registerEl={registerEl}
                            onChange={onBlockChange}
                            onSelect={onBlockSelect}
                            onEnter={(id) => addBlockAfter(id, { type: 'TEXT', text: '' })}
                          />
                          <span className="dt-rel dt-ed2row__menu">
                            <Button unstyled className="dt-ed2dots" title="Paragraph actions" aria-label={`${label} actions`} aria-haspopup="menu" aria-expanded={open} onClick={() => setBlockMenu(open ? null : block.id)} data-testid={`rtr-para-menu-${i}`}>···</Button>
                            <Menu open={open} onClose={() => setBlockMenu(null)} className="dt-menu dt-menu--right dt-menu--blk" label={`${label} actions`}>
                              <Button unstyled role="menuitem" className="dt-menu__item" disabled={i === 0} onClick={() => { setBlockMenu(null); moveBlock(block.id, i - 1); }} data-testid={`rtr-para-up-${i}`}>Move up</Button>
                              <Button unstyled role="menuitem" className="dt-menu__item" disabled={i === draft.blocks.length - 1} onClick={() => { setBlockMenu(null); moveBlock(block.id, i + 1); }} data-testid={`rtr-para-down-${i}`}>Move down</Button>
                              <Button unstyled role="menuitem" className="dt-menu__item" onClick={() => { setBlockMenu(null); duplicateBlock(block.id); }} data-testid={`rtr-para-dup-${i}`}>Duplicate</Button>
                              <Button unstyled role="menuitem" className="dt-menu__item dt-menu__item--danger" onClick={() => { setBlockMenu(null); deleteBlock(block.id); }} data-testid={`rtr-para-del-${i}`}>Delete</Button>
                            </Menu>
                          </span>
                        </div>
                      );
                    })}
                    <Button
                      unstyled
                      className="dt-ed2addpara"
                      onClick={() => addBlockAfter(null, { type: 'TEXT', text: '' })}
                      onDragOver={(e) => { if (dragRef.current != null) e.preventDefault(); }}
                      onDrop={rowDrop('end')}
                      data-testid="rtr-add-para"
                    >
                      <PlusIcon />Add paragraph
                    </Button>
                    <div className="dt-ed2row dt-ed2row--sig" data-testid="rtr-signature-row">
                      <span className="dt-ed2handle dt-ed2handle--lock" title="Fixed · always last"><LockIcon /></span>
                      <span className="dt-ed2pill dt-ed2pill--sig">Signature</span>
                      <div className="dt-ed2sig">
                        <SignatureBlock mode="template" nameLabel={talentLabel} />
                        <div className="dt-ed2sig__note"><LockIcon size={12} stroke="currentColor" />Added by Aramo e-sign · signed by the Talent · always the last block. It can't be edited, moved or deleted.</div>
                      </div>
                      <span />
                    </div>
                  </div>
                </div>
              ) : null}

              {tab === 'preview' ? (
                <div className="dt-card dt-ed2card" role="tabpanel" data-testid="rtr-panel-preview">
                  <div className="dt-ed2pvhead">
                    <span className="dt-ed2cardhead__t">Preview</span>
                    <span className="dt-samplepill">Sample preview data</span>
                    <span className="dt-ed2cardhead__s">Not a real RTR. Highlighted values are sample data and are filled from the live record when the RTR is sent.</span>
                  </div>
                  {inline.status === 'loading' ? <p className="dt-note">Loading preview…</p> : null}
                  {inline.status === 'error' ? <p className="dt-note dt-note--err">{inline.message}</p> : null}
                  {inline.status === 'ready' ? (
                    <>
                      {!isPreviewed ? (
                        <div className="dt-ed2stale">
                          Changed since this preview.
                          <Button unstyled className="dt-link" onClick={() => void openPreviewTab()} data-testid="rtr-preview-refresh">Refresh preview</Button>
                        </div>
                      ) : null}
                      <PreviewPaper content={inline.content} map={map} className="dt-ed2paper" testId="rtr-inline-preview-paper" />
                    </>
                  ) : null}
                </div>
              ) : null}

              {tab === 'versions' ? (
                <div className="dt-card dt-card--clip" role="tabpanel" data-testid="rtr-panel-versions">
                  <div className="dt-verhead">
                    <span className="dt-verhead__t">Versions</span>
                    <span className="dt-verhead__h">Approved versions can't be edited. Changes go into this draft.</span>
                  </div>
                  {verAll.map((v) => (
                    <div key={v.id} className={`dt-verrow${v.status === 'DRAFT' ? ' dt-verrow--draft' : ''}`} data-testid={`rtr-tabver-${v.version_number}`}>
                      <span className={`dt-ver__n${v.status === 'RETIRED' ? ' dt-ver__n--retired' : ''}`}>v{v.version_number}</span>
                      <span><span className={`dt-pill ${pillClass(v.status)}`}><span className="dt-pill__dot" />{pillLabel(v.status)}</span></span>
                      <span className="dt-ver__when">{whenOf(v)}</span>
                      <span className="dt-ver__acts">
                        {v.status !== 'DRAFT' ? <Button unstyled className="dt-link" onClick={() => viewVersion(v)}>View</Button> : null}
                        <Button unstyled className="dt-link" onClick={() => (v.status === 'DRAFT' ? void openPreviewTab() : viewVersion(v))}>Preview</Button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {tab === 'settings' ? (
                <div className="dt-card dt-ed2card" role="tabpanel" data-testid="rtr-panel-settings">
                  <div className="dt-ed2cardhead__t">Settings</div>
                  <div className="dt-ed2cardhead__s dt-mb14">Set by the document type, not per version. Shown here so the admin knows how this template will be used.</div>
                  <div className="dt-ed2facts">
                    {SETTINGS_FACTS.map((f) => (
                      <div className="dt-ed2fact" key={f.l}>
                        <div className="dt-ed2fact__l">{f.l}</div>
                        <div className="dt-ed2fact__v">{f.v}</div>
                        <div className="dt-ed2fact__s">{f.s}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Right rail */}
            <div className="dt-ed2rail">
              <div className="dt-railcard" data-testid="rtr-rail-fields">
                <div className="dt-railhead">
                  <span className="dt-railhead__ic"><DocOutline size={16} /></span>
                  <span className="dt-railhead__t">Fields in this draft</span>
                  <span className="dt-railhead__n" data-testid="rtr-fields-in-use">{usedKeys.length} in use</span>
                </div>
                <div className="dt-railsearch">
                  <SearchIcon />
                  <Input unstyled className="dt-railsearch__in" placeholder="Search fields…" aria-label="Search fields" value={fq} onChange={(e) => setFq(e.target.value)} data-testid="rtr-field-search" />
                </div>
                {railGroups.map((g) => {
                  const open = q !== '' || shut[g.id] !== true;
                  return (
                    <div className="dt-railgrp" key={g.id}>
                      <Button unstyled className="dt-railgrp__h" aria-expanded={open} onClick={() => setShut((s) => ({ ...s, [g.id]: !(s[g.id] === true) }))} data-testid={`rtr-railgrp-${g.id}`}>
                        <span className="dt-railgrp__ic"><SourceIcon source={g.source} /></span>
                        <span className="dt-railgrp__t">{g.label} fields</span>
                        <span className="dt-railgrp__n">({g.items.length})</span>
                        <span className={`dt-railgrp__chev${open ? '' : ' dt-railgrp__chev--shut'}`}><ChevronDown size={14} /></span>
                      </Button>
                      {open ? (
                        <div className="dt-railgrp__items">
                          {g.shown.map((it) => {
                            const u = usedKeys.includes(it.key);
                            return (
                              <Button
                                unstyled
                                key={it.key}
                                className={`dt-railchip${u ? ' dt-railchip--used' : ''}`}
                                title={u ? 'In this draft · click to insert again' : 'Click to insert at the cursor'}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => insertField(it.key)}
                                data-testid={`rtr-railfield-${it.key}`}
                              >
                                {u ? '✓ ' : ''}{it.key === JOB_DESCRIPTION_KEY ? 'Job description' : it.label}
                              </Button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {railGroups.length === 0 ? <div className="dt-rail__none">No governed field matches. Only fields from the catalog can be used.</div> : null}
                {bad.length > 0 ? <div className="dt-rail__bad">{bad.length} unknown field{bad.length > 1 ? 's' : ''} — remove before approval.</div> : null}
              </div>

              <div className="dt-railcard" data-testid="rtr-checklist">
                <div className="dt-railhead dt-railhead--tight">
                  <span className={ckDone === checklist.length ? 'dt-ck--done' : 'dt-ck--todo'}><CheckCircleIcon /></span>
                  <span className="dt-railhead__t">Approval checklist</span>
                  <span className="dt-railhead__n" data-testid="rtr-checklist-count">{ckDone} of {checklist.length}</span>
                </div>
                <div className="dt-ck__sub">Worked out from the draft. All items must be complete to approve.</div>
                {checklist.map((c, i) => (
                  <div className="dt-ck" key={c.label} data-testid={`rtr-check-${i + 1}`} data-ok={c.ok ? 'true' : 'false'}>
                    <span className={`dt-ck__mark${c.ok ? ' dt-ck__mark--ok' : ''}`}>{c.ok ? '✓' : ''}</span>
                    <span className={`dt-ck__l${c.ok ? ' dt-ck__l--ok' : ''}`}>{c.label}</span>
                  </div>
                ))}
              </div>

              <div className="dt-railcard dt-railcard--hist" data-testid="rtr-rail-history">
                <div className="dt-railhead dt-railhead--hist">
                  <span className="dt-railhead__ic dt-railhead__ic--muted"><ClockIcon /></span>
                  <span className="dt-railhead__t">Version history</span>
                  <Button unstyled className="dt-link dt-ml-auto" onClick={() => setTab('versions')} data-testid="rtr-history-all">View all</Button>
                </div>
                {verAll.slice(0, 3).map((v) => {
                  const date = v.status === 'DRAFT' ? (dirty ? 'Editing now' : 'Draft') : fmtDate(v.activated_at ?? v.created_at);
                  const whoId = v.status === 'DRAFT' ? v.created_by : v.activated_by;
                  const who = v.status === 'DRAFT' && session != null && v.created_by === session.sub ? 'You' : shortName(nameOf(whoId));
                  return (
                    <div className="dt-vmini" key={v.id}>
                      <b className={v.status === 'RETIRED' ? 'dt-ver__n--retired' : ''}>v{v.version_number}</b>
                      <span className={`dt-pill dt-pill--sm ${pillClass(v.status)}`}>{pillLabel(v.status)}</span>
                      <span className="dt-vmini__d">{date}</span>
                      <span className="dt-vmini__w">{who}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="dt-footer" data-testid="rtr-editor-footer">
        <span className="dt-pill dt-pill--draft dt-nowrap">Draft</span>
        <span className="dt-footer__save" data-testid="rtr-footer-save-state">{saveState}</span>
        <span className={`dt-footer__gate ${blockReason !== '' ? 'dt-footer__note--block' : 'dt-footer__note--ok'}`} data-testid="rtr-footer-gate">
          · {blockReason !== '' ? blockReason : 'Ready to approve'}
        </span>
        <span className="dt-footer__acts">
          <Button unstyled className="dt-link dt-link--danger dt-nowrap" onClick={() => setDiscardOpen(true)} disabled={busy} data-testid="rtr-editor-discard">Discard draft</Button>
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--ic dt-nowrap" onClick={() => void openPreviewModal()} disabled={busy} data-testid="rtr-editor-preview"><EyeIcon />Preview</Button>
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--ic dt-nowrap" onClick={() => void save()} disabled={busy || !dirty} data-testid="rtr-editor-save"><SaveIcon />Save draft</Button>
          <Button
            unstyled
            className={`dt-btn dt-btn--ic dt-nowrap ${approveDisabled ? 'dt-btn--disabled' : 'dt-btn--primary'}`}
            onClick={() => { if (!approveDisabled) setApproveOpen(true); }}
            disabled={approveDisabled || busy}
            title={blockReason !== '' ? blockReason : 'Approve and make this the active version'}
            data-testid="rtr-editor-approve"
          >
            <CheckCircleIcon size={15} />Approve &amp; activate
          </Button>
        </span>
      </div>

      {modal != null ? <PreviewModal content={modal} map={map} onClose={() => setModal(null)} /> : null}
      {approveOpen ? (
        <ApproveModal draftVersion={draft.n} activeVersion={activeN} busy={busy} onCancel={() => setApproveOpen(false)} onApprove={() => void approve()} />
      ) : null}
      {discardOpen ? (
        <DiscardModal draftVersion={draft.n} busy={busy} onCancel={() => setDiscardOpen(false)} onDiscard={() => void discard()} />
      ) : null}
    </div>
  );
}
