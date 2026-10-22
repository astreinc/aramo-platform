import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, safeErrorMessage, TextArea, useSession, useToast, type Session } from '@aramo/fe-foundation';

import {
  activateTemplateVersion,
  captureVersionLogo,
  deleteDraftVersion,
  fetchTemplateCatalog,
  listAllowedBindings,
  listDocumentTemplates,
  listTemplateVersions,
  previewTemplateVersion,
  resolveUserNames,
  removeVersionLogo,
  updateDocumentTemplate,
  updateDraftVersion,
  versionLogoUrl,
  canApproveTemplates,
  canAuthorTemplates,
  RIGHT_TO_REPRESENT_TYPE_ID,
  RTR_GENERATED_SCHEMA_V1,
  RTR_HTML_SCHEMA_V1,
  type TemplateBinding,
  type TemplateCatalog,
  type TemplateLogo,
  type TemplateSamplePreview,
  type TemplateVersionView,
  type TenantLogoInfo,
} from './document-templates-api';
import {
  bindingMapFrom,
  buildFieldSchema,
  fmtDate,
  groupBindings,
  parseContent,
  parseLabelSegments,
  CheckCircleIcon,
  ChevronDown,
  ClockIcon,
  CloudIcon,
  DocOutline,
  DragDots,
  EyeIcon,
  LockIcon,
  LogoIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SignatureBlock,
  SourceIcon,
  TabIcon,
  JOB_DESCRIPTION_KEY,
  TALENT_NAME_KEY,
  type BindingMap,
} from './dt-ui';
import { BlockBox, HTML_CODEC, insertAtRange, makeFieldChip, TEXT_TOKEN_CODEC, type BlockCodec } from './dt-block-editor';
import { activeMarks, blocksToHtml, htmlToBlocks, toggleMark, type BlockKind } from './dt-html';
import { Letterhead, type LetterheadInfo } from './dt-html-render';
import { useDocTemplateRoutes } from './dt-routes';
import {
  contentFromVersion,
  htmlOf,
  previewContentFrom,
  ApproveModal,
  DiscardModal,
  PreviewModal,
  PreviewPaper,
  SampleValues,
  type PreviewContent,
} from './dt-modals';
import './document-templates.css';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11) + PO §9 "Draft editor v2" — the Right-to-Represent DRAFT
// editor, styled to the approved prototype (Document Templates.dc.html #rtr/draft/example):
// template details, a tabbed builder (Document builder · Preview · Versions · Settings),
// a right rail (fields in this draft · approval checklist · version history) and a sticky
// one-row footer that carries the approval gate. Fields come ONLY from the governed catalog
// (GET allowed-bindings); an unknown field renders a red chip and blocks approval. The
// gate is server-authoritative (Save re-arms it; Preview records it; Approve re-validates)
// — the derived checklist mirrors it. Content is rtr-html-v1 (Amendment A1: B/I/U, headings,
// lists, fields, tenant-logo letterhead) through HTML_CODEC; an existing rtr-generated-v1
// draft still opens and saves as v1 through TEXT_TOKEN_CODEC, where only the Heading
// toggle can persist — so only that control is rendered for it (no dead controls).


type Tab = 'builder' | 'preview' | 'versions' | 'settings';
interface NewBlock { readonly kind: BlockKind; readonly value: string }
interface EdBlock extends NewBlock { readonly id: string }
type Schema = 'v1' | 'html';

interface Draft {
  templateId: string;
  versionId: string;
  n: number;
  name: string;
  savedName: string;
  title: string;
  blocks: EdBlock[];
  schema: Schema;
  logo: boolean; // html only: the tenant-logo letterhead is the first child
  logoAsset: TemplateLogo | null;
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
      tenantLogo: TenantLogoInfo | null;
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

const SETTINGS_FACTS_BASE: ReadonlyArray<{ l: string; v: string; s: string }> = [
  { l: 'DOCUMENT TYPE', v: 'Right to Represent', s: 'Governed document type' },
  { l: 'SCOPE', v: 'Tenant default', s: 'Client-specific templates may come later' },
  { l: 'USED BY', v: 'Requisition → Talent → Send RTR', s: 'Recruiters can’t choose another template' },
  { l: 'SIGNER', v: 'Talent', s: 'Recipient is locked to the talent’s email' },
  { l: 'SIGNING', v: 'Aramo e-sign', s: 'Frozen from this version when sent' },
  { l: 'SIGNATURE PLACEMENT', v: 'End of document (fixed)', s: 'Talent signature · printed name · date signed' },
];
const ALLOWED_V1 = { l: 'ALLOWED CONTENT', v: 'Headings and paragraphs with governed fields', s: 'Fields come from the governed catalog only' };
const ALLOWED_HTML = { l: 'ALLOWED CONTENT', v: 'Text, headings, lists, fields, tenant logo', s: 'No tables, images or custom fonts' };

const TOOL_MARKS: ReadonlyArray<{ tag: 'b' | 'i' | 'u'; g: string; tip: string; cls: string }> = [
  { tag: 'b', g: 'B', tip: 'Bold', cls: 'dt-ed2tool--b' },
  { tag: 'i', g: 'I', tip: 'Italic', cls: 'dt-ed2tool--i' },
  { tag: 'u', g: 'U', tip: 'Underline', cls: 'dt-ed2tool--u' },
];

function apiReason(err: unknown): { status: number | null; reason: string | null } {
  const e = err as { status?: unknown; details?: { reason?: unknown } } | null;
  return {
    status: e != null && typeof e.status === 'number' ? e.status : null,
    reason: e != null && typeof e.details?.reason === 'string' ? e.details.reason : null,
  };
}
const SAVE_REASON_COPY: Record<string, string> = {
  unknown_field: 'A field in this draft isn’t a governed field. Remove the red field and save again.',
  logo_position: 'The tenant logo must be the first block of the document.',
  logo_asset_mismatch: 'The tenant logo is out of date. Remove it and add it again, then save.',
  content_too_large: 'This document is too long to save. Shorten it and try again.',
  unknown_asset: 'This draft contains an image that isn’t allowed. Only the tenant logo can be used.',
};

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
  templateId,
  sessionOverride,
  listTemplatesFn = listDocumentTemplates,
  listVersionsFn = listTemplateVersions,
  listBindingsFn,
  catalogFn,
  captureLogoFn = captureVersionLogo,
  removeLogoFn = removeVersionLogo,
  resolveNamesFn = resolveUserNames,
  updateFn = updateDraftVersion,
  renameFn = updateDocumentTemplate,
  previewFn = previewTemplateVersion,
  activateFn = activateTemplateVersion,
  discardFn = deleteDraftVersion,
}: {
  // DOC-TEMPLATE-LIB-1 T-4 — the tenant template whose open draft is edited (Org Home
  // routes by id). Absent: the tenant's Right to Represent template.
  readonly templateId?: string;
  readonly sessionOverride?: Session;
  readonly listTemplatesFn?: typeof listDocumentTemplates;
  readonly listVersionsFn?: typeof listTemplateVersions;
  readonly listBindingsFn?: typeof listAllowedBindings;
  // A1 — catalog incl. tenant_logo; when only listBindingsFn is given, no tenant logo is known.
  readonly catalogFn?: (templateId: string) => Promise<TemplateCatalog>;
  readonly captureLogoFn?: typeof captureVersionLogo;
  readonly removeLogoFn?: typeof removeVersionLogo;
  readonly resolveNamesFn?: typeof resolveUserNames;
  readonly updateFn?: typeof updateDraftVersion;
  readonly renameFn?: typeof updateDocumentTemplate;
  readonly previewFn?: typeof previewTemplateVersion;
  readonly activateFn?: typeof activateTemplateVersion;
  readonly discardFn?: typeof deleteDraftVersion;
} = {}) {
  const routes = useDocTemplateRoutes();
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  // ORG-UX-1 §4.1 — editing, preview, discard, logo and fields are authoring
  // (author-or-manage); Approve & activate is manage-only (an author never sees it).
  const canAuthor = canAuthorTemplates(session);
  const canApprove = canApproveTemplates(session);
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
  const [marks, setMarks] = useState<{ b: boolean; i: boolean; u: boolean }>({ b: false, i: false, u: false });
  const [saveIssue, setSaveIssue] = useState<string | null>(null);
  const [logoRev, setLogoRev] = useState(0);

  const els = useRef<Record<string, HTMLDivElement | null>>({});
  const selRef = useRef<{ id: string; range: Range | null } | null>(null);
  const dragRef = useRef<string | null>(null);
  const focusNext = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => (templateId != null ? t.id === templateId : t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID)) ?? null;
      if (rtr == null) { setLoad({ status: 'nodraft' }); return; }
      const loadCatalog = catalogFn ?? (listBindingsFn != null
        ? (id: string) => listBindingsFn(id).then((b): TemplateCatalog => ({ bindings: b, tenantLogo: null }))
        : fetchTemplateCatalog);
      const [versions, catalog] = await Promise.all([listVersionsFn(rtr.id), loadCatalog(rtr.id)]);
      const bindings = catalog.bindings;
      const d = versions.find((v) => v.status === 'DRAFT');
      if (d == null) { setLoad({ status: 'nodraft' }); return; }
      const map = bindingMapFrom(bindings);
      const parsed = parseContent(d.field_schema, map);
      const storedHtml = htmlOf(d.field_schema);
      const schema: Schema = d.render_schema_version === RTR_HTML_SCHEMA_V1 || storedHtml != null ? 'html' : 'v1';
      const doc = schema === 'html' ? htmlToBlocks(storedHtml ?? '') : null;
      const active = versions.find((v) => v.id === rtr.current_version_id) ?? versions.find((v) => v.status === 'ACTIVE') ?? null;
      const hasNotes = Object.prototype.hasOwnProperty.call(d, 'internal_notes');
      const notes = hasNotes ? (d.internal_notes ?? '') : null;
      const ids = [...new Set(versions.flatMap((v) => [v.activated_by, v.created_by]).filter((x): x is string => x != null))];
      let names: Record<string, string> = {};
      try { names = await resolveNamesFn(ids); } catch { names = {}; }
      const loaded: NewBlock[] = doc != null
        ? doc.blocks
        : parsed.blocks.map((b) => ({ kind: b.type === 'HEADING' ? 'h2' as const : 'p' as const, value: b.text }));
      const blocks = loaded.length > 0 ? loaded : [{ kind: 'p' as const, value: '' }];
      setDraft({
        templateId: rtr.id, versionId: d.id, n: d.version_number, name: rtr.name, savedName: rtr.name,
        title: parsed.title, blocks: blocks.map((b) => ({ ...b, id: newBlockId() })),
        schema, logo: doc?.logo ?? false, logoAsset: d.logo ?? null,
        notes, savedNotes: notes, createdBy: d.created_by,
      });
      setNameDirty(false);
      setContentDirty(false);
      setPreviewed(d.previewed_fingerprint != null && d.previewed_fingerprint === d.content_fingerprint);
      setLoad({ status: 'ready', bindings, tenantLogo: catalog.tenantLogo, map, versions, active, names: names ?? {} });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load the draft.') });
    }
  }, [templateId, listTemplatesFn, listVersionsFn, listBindingsFn, catalogFn, resolveNamesFn]);

  useEffect(() => { if (canAuthor) void refetch(); }, [canAuthor, refetch]);

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
  const codec: BlockCodec = draft?.schema === 'html' ? HTML_CODEC : TEXT_TOKEN_CODEC;
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
      if (cur == null || cur.value === text) return d;
      setContentDirty(true);
      setPreviewed(false);
      setSaveError(null);
      return { ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, value: text } : b)) };
    });
  }, []);
  const onBlockSelect = useCallback((id: string, range: Range | null) => {
    setActiveId(id);
    selRef.current = { id, range };
    setMarks(activeMarks(els.current[id] ?? null, range));
  }, []);

  function addBlockAfter(afterId: string | null, block: NewBlock) {
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
    setBlocks(rest.length > 0 ? rest : [{ id: newBlockId(), kind: 'p', value: '' }]);
    if (activeId === id) setActiveId(null);
  }
  function duplicateBlock(id: string) {
    const b = draft?.blocks.find((x) => x.id === id);
    if (b != null) addBlockAfter(id, { kind: b.kind, value: b.value });
  }
  // H toggles p↔h2; • / 1. toggle a list (each line ↔ li). The codec converts the value.
  function toggleKind(target: 'h2' | 'ul' | 'ol') {
    if (draft == null || activeId == null) return;
    setBlocks(draft.blocks.map((b) => {
      if (b.id !== activeId) return b;
      const to: BlockKind = b.kind === target ? 'p' : target;
      return { ...b, kind: to, value: codec.convert(b.value, b.kind, to) };
    }));
  }
  function toggleMarkCmd(tag: 'b' | 'i' | 'u') {
    if (draft == null || activeId == null) return;
    const el = els.current[activeId];
    const block = draft.blocks.find((b) => b.id === activeId);
    if (el == null || block == null) return;
    let range: Range | null = null;
    try {
      const sel = window.getSelection();
      if (sel != null && sel.rangeCount > 0 && el.contains(sel.anchorNode)) range = sel.getRangeAt(0);
    } catch { /* noop */ }
    if (range == null) range = selRef.current?.id === activeId ? selRef.current.range : null;
    if (!toggleMark(el, range, tag)) return;
    onBlockChange(activeId, codec.serialize(el, map, block.kind));
    try {
      const sel = window.getSelection();
      const r = sel != null && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
      selRef.current = { id: activeId, range: r };
      setMarks(activeMarks(el, r));
    } catch { /* noop */ }
  }
  async function addLogo() {
    if (draft == null) return;
    setBusy(true);
    try {
      const res = await captureLogoFn(draft.versionId);
      const asset: TemplateLogo | null = res != null && typeof res.asset_id === 'string' ? { asset_id: res.asset_id, mime: res.mime } : null;
      setDraft((d) => (d != null ? { ...d, logo: true, logoAsset: asset ?? d.logoAsset } : d));
      setLogoRev((r) => r + 1);
      setContentDirty(true);
      setPreviewed(false);
      toast.show('Tenant logo added above the title · change it under Settings → Tenant profile');
    } catch (err) {
      const { reason } = apiReason(err);
      toast.show(reason === 'no_tenant_logo' ? 'Add a logo in Settings → Tenant profile' : safeErrorMessage(err, 'Could not add the tenant logo.'));
    } finally { setBusy(false); }
  }
  async function removeLogo() {
    if (draft == null) return;
    setBusy(true);
    try {
      await removeLogoFn(draft.versionId);
      setDraft((d) => (d != null ? { ...d, logo: false, logoAsset: null } : d));
      setContentDirty(true);
      setPreviewed(false);
      toast.show('Tenant logo removed');
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not remove the tenant logo.'));
    } finally { setBusy(false); }
  }

  function insertField(key: string) {
    if (draft == null) return;
    const label = map.labelByToken[key];
    setInsertOpen(false);
    if (label == null) return;
    if (key === JOB_DESCRIPTION_KEY) { addBlockAfter(activeId, { kind: 'p', value: codec.fieldBlock(key, label) }); return; }
    const sel = selRef.current;
    const id = activeId != null && draft.blocks.some((b) => b.id === activeId) ? activeId : null;
    const el = id != null ? els.current[id] : null;
    if (id != null && el != null && sel != null && sel.id === id && sel.range != null && el.contains(sel.range.startContainer)) {
      // At the caret in the focused block: insert an atomic chip node, then re-serialise.
      insertAtRange(el, sel.range, [makeFieldChip(key, label), document.createTextNode(' ')]);
      try { const s = window.getSelection(); if (s != null && s.rangeCount > 0) selRef.current = { id, range: s.getRangeAt(0).cloneRange() }; } catch { /* noop */ }
      const blk = draft.blocks.find((b) => b.id === id);
      onBlockChange(id, codec.serialize(el, map, blk?.kind ?? 'p'));
      return;
    }
    // Otherwise: at the end of the last block.
    const last = draft.blocks[draft.blocks.length - 1];
    if (last == null) return;
    setBlocks(draft.blocks.map((b) => (b.id === last.id ? { ...b, value: codec.appendField(b.value, b.kind, key, label) } : b)));
  }
  function addClause(text: string) {
    setClauseOpen(false);
    addBlockAfter(activeId, { kind: 'p', value: codec.fromTemplate(text, map) });
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
      const sentHtml = draft.schema === 'html' ? blocksToHtml(draft.logo, draft.blocks) : null;
      const input: { field_schema: unknown; render_schema_version: string; internal_notes?: string | null } = sentHtml != null
        ? { field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: draft.title, html: sentHtml }, render_schema_version: RTR_HTML_SCHEMA_V1 }
        : {
            field_schema: buildFieldSchema(RTR_GENERATED_SCHEMA_V1, draft.title, draft.blocks.map((b) => ({ type: b.kind === 'h2' ? 'HEADING' : 'TEXT', text: b.value })), map),
            render_schema_version: RTR_GENERATED_SCHEMA_V1,
          };
      if (draft.notes !== null && draft.notes !== draft.savedNotes) input.internal_notes = draft.notes;
      const res = await updateFn(draft.versionId, input);
      setNameDirty(false);
      setContentDirty(false);
      setSaveIssue(null);
      // rtr-html-v1: the server returns its SANITIZED html — re-render from it when it differs.
      const resHtml = sentHtml != null && res != null ? htmlOf(res.field_schema) : null;
      if (resHtml != null && sentHtml != null) {
        const back = htmlToBlocks(resHtml);
        const sentCanon = htmlToBlocks(sentHtml);
        if (blocksToHtml(back.logo, back.blocks) !== blocksToHtml(sentCanon.logo, sentCanon.blocks)) {
          const nb = back.blocks.length > 0 ? back.blocks : [{ kind: 'p' as const, value: '' }];
          setDraft((cur) => (cur != null ? { ...cur, logo: back.logo, blocks: nb.map((b) => ({ ...b, id: newBlockId() })) } : cur));
        }
      }
      if (res != null && res.logo !== undefined) { const lg = res.logo; setDraft((cur) => (cur != null ? { ...cur, logoAsset: lg } : cur)); }
      // The server re-arms (or keeps) the §18 gate — trust its markers.
      setPreviewed(res != null && res.previewed_fingerprint != null && res.previewed_fingerprint === res.content_fingerprint);
      const savedNotes = draft.notes;
      setDraft((cur) => (cur != null ? { ...cur, savedNotes } : cur));
      setSavedAt(new Date());
      toast.show('Draft saved.');
      return true;
    } catch (err) {
      // 422 unknown_field / logo_position → an inline, actionable error; the draft is kept.
      const { status, reason } = apiReason(err);
      const known = status === 422 && reason != null ? SAVE_REASON_COPY[reason] : undefined;
      const msg = known ?? safeErrorMessage(err, 'Could not save the draft.');
      setSaveError(msg);
      setSaveIssue(known ?? null);
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
      return previewContentFrom(res, `Draft v${d.n} · ${d.name}`, draftLetterhead(d));
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
  function draftLetterhead(d: Draft): LetterheadInfo {
    const name = load.status === 'ready' ? load.tenantLogo?.tenant_name ?? '' : '';
    return { src: versionLogoUrl(d.versionId, d.logoAsset?.asset_id ?? (logoRev > 0 ? String(logoRev) : null)), tenantName: name };
  }
  function viewVersion(v: TemplateVersionView) {
    const name = load.status === 'ready' ? load.tenantLogo?.tenant_name ?? '' : '';
    const lh: LetterheadInfo = { src: v.logo != null ? versionLogoUrl(v.id, v.logo.asset_id) : null, tenantName: name };
    setModal(contentFromVersion(v, map, `v${v.version_number} · ${draft?.name ?? ''} · ${pillLabel(v.status)}`, lh));
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
      navigate(`${routes.detail(draft.templateId)}?activated=1`);
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
      navigate(routes.detail(draft.templateId));
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not discard this draft.'));
      setBusy(false);
    }
  }

  if (!canAuthor) {
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

  const detailHref = draft != null ? routes.detail(draft.templateId) : templateId != null ? routes.detail(templateId) : routes.list;
  const crumb = (n: number | string) => (
    <div className="dt-crumb">
      <a onClick={() => navigate(routes.list)}>Document templates</a><span>/</span>
      <a onClick={() => navigate(detailHref)} data-testid="rtr-editor-back">Right to Represent</a><span>/</span>
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
  const addScan = (r: { used: string[]; bad: string[] }) => {
    r.used.forEach((k) => { if (!usedKeys.includes(k)) usedKeys.push(k); });
    r.bad.forEach((k) => { if (!bad.includes(k)) bad.push(k); });
  };
  if (draft.schema === 'v1') {
    for (const s of parseLabelSegments(draft.title, map)) {
      if (s.kind === 'field') { const k = map.tokenByLabel[s.t]; if (k != null && !usedKeys.includes(k)) usedKeys.push(k); }
      if (s.kind === 'bad' && !bad.includes(s.t)) bad.push(s.t);
    }
  }
  draft.blocks.forEach((b) => addScan(codec.scan(b.value, map)));
  const nameOk = draft.name.trim() !== '';
  const titleOk = draft.title.trim() !== '';
  const emptyDoc = draft.blocks.every((b) => codec.isEmpty(b.value));
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
  const rich = codec.rich;
  const tenantLogo = load.tenantLogo;
  const settingsFacts = [...SETTINGS_FACTS_BASE, rich ? ALLOWED_HTML : ALLOWED_V1];
  const jdValue = jdLabel != null ? codec.fieldBlock(JOB_DESCRIPTION_KEY, jdLabel) : null;

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
    if (b.kind === 'h2') return 'Heading';
    if (b.kind === 'ul' || b.kind === 'ol') return 'List';
    if (jdValue != null && b.value.trim() === jdValue) return 'Job description';
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
                <Button unstyled role="menuitem" className="dt-menu__item" onClick={() => navigate(detailHref)}>Back to Right to Represent</Button>
                <Button unstyled role="menuitem" className="dt-menu__item dt-menu__item--danger" onClick={() => { setMoreOpen(false); setDiscardOpen(true); }}>Discard draft</Button>
              </Menu>
            </span>
          </div>
          <div className="dt-ed2based">
            Based on <b>{activeN != null ? `v${activeN}` : 'a blank document'}</b> · not used by any workflow until approved
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
                      <Button unstyled className="dt-obtn" onClick={() => addBlockAfter(activeId, { kind: 'p', value: '' })} data-testid="rtr-add-para-top">
                        <PlusIcon />Add paragraph
                      </Button>
                    </span>
                  </div>
                  <div className="dt-ed2format">
                    <span className="dt-ed2format__l">FORMAT</span>
                    <span className="dt-ed2tools" role="toolbar" aria-label="Format">
                      {rich ? TOOL_MARKS.map((t) => (
                        <Button
                          unstyled
                          key={t.tag}
                          className={`dt-ed2tool ${t.cls}${marks[t.tag] ? ' dt-ed2tool--on' : ''}`}
                          title={activeBlock != null ? t.tip : 'Click a paragraph first'}
                          aria-label={t.tip}
                          aria-pressed={marks[t.tag]}
                          disabled={activeBlock == null}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => toggleMarkCmd(t.tag)}
                          data-testid={`rtr-format-${t.tag}`}
                        >
                          {t.g}
                        </Button>
                      )) : null}
                      <Button
                        unstyled
                        className={`dt-ed2tool${activeBlock?.kind === 'h2' ? ' dt-ed2tool--on' : ''}`}
                        title={activeBlock != null ? 'Section heading' : 'Click a paragraph first'}
                        aria-label="Section heading"
                        aria-pressed={activeBlock?.kind === 'h2'}
                        disabled={activeBlock == null}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleKind('h2')}
                        data-testid="rtr-format-heading"
                      >
                        H
                      </Button>
                      {rich ? (
                        <>
                          <Button
                            unstyled
                            className={`dt-ed2tool dt-ed2tool--ul${activeBlock?.kind === 'ul' ? ' dt-ed2tool--on' : ''}`}
                            title={activeBlock != null ? 'Bulleted list' : 'Click a paragraph first'}
                            aria-label="Bulleted list"
                            aria-pressed={activeBlock?.kind === 'ul'}
                            disabled={activeBlock == null}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleKind('ul')}
                            data-testid="rtr-format-ul"
                          >
                            •
                          </Button>
                          <Button
                            unstyled
                            className={`dt-ed2tool dt-ed2tool--ol${activeBlock?.kind === 'ol' ? ' dt-ed2tool--on' : ''}`}
                            title={activeBlock != null ? 'Numbered list' : 'Click a paragraph first'}
                            aria-label="Numbered list"
                            aria-pressed={activeBlock?.kind === 'ol'}
                            disabled={activeBlock == null}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => toggleKind('ol')}
                            data-testid="rtr-format-ol"
                          >
                            1.
                          </Button>
                        </>
                      ) : null}
                    </span>
                    {rich ? (
                      draft.logo ? (
                        <Button unstyled className="dt-ed2logo dt-nowrap" title="Remove the organization logo from the top of the document" onMouseDown={(e) => e.preventDefault()} onClick={() => void removeLogo()} disabled={busy} data-testid="rtr-logo-remove">
                          <LogoIcon />Remove logo
                        </Button>
                      ) : (
                        <span title={tenantLogo?.available === true ? 'Adds your organization’s logo from Tenant profile above the title' : 'Add a logo in Settings → Tenant profile'} className="dt-nowrap" data-testid="rtr-logo-add-wrap">
                          <Button unstyled className="dt-ed2logo dt-nowrap" onMouseDown={(e) => e.preventDefault()} onClick={() => void addLogo()} disabled={busy || tenantLogo?.available !== true} data-testid="rtr-logo-add">
                            <LogoIcon />Tenant logo
                          </Button>
                        </span>
                      )
                    ) : null}
                    <span className="dt-ed2format__hint">Click × on a field to remove it · drag ⋮⋮ to reorder</span>
                  </div>
                  {saveIssue != null ? <div className="dt-ed2issue" data-testid="rtr-save-issue">{saveIssue}</div> : null}
                  <div className="dt-ed2rows">
                    {rich && draft.logo ? (
                      <div className="dt-ed2row" data-testid="rtr-letterhead-row">
                        <span />
                        <span className="dt-ed2pill dt-ed2pill--blk">Letterhead</span>
                        <Letterhead info={draftLetterhead(draft)} variant="editor" testId="rtr-letterhead" />
                        <span />
                      </div>
                    ) : null}
                    <div className="dt-ed2row dt-ed2row--center">
                      <span />
                      <span className="dt-ed2pill">Title</span>
                      <div className="dt-ed2title" data-testid="rtr-builder-title">{draft.title}</div>
                      <span />
                    </div>
                    {draft.blocks.map((block, i) => {
                      const heading = block.kind === 'h2';
                      const label = blockLabel(block);
                      const open = blockMenu === block.id;
                      return (
                        <div
                          key={block.id}
                          className={`dt-ed2row${dragOver === block.id ? ' dt-ed2row--drop' : ''}`}
                          data-testid={`rtr-para-${i}`}
                          data-block-type={block.kind === 'h2' ? 'HEADING' : block.kind === 'p' ? 'TEXT' : 'LIST'}
                          data-kind={block.kind}
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
                            value={block.value}
                            kind={block.kind}
                            codec={codec}
                            map={map}
                            placeholder={heading ? 'Heading' : label}
                            testId={`rtr-para-text-${i}`}
                            registerEl={registerEl}
                            onChange={onBlockChange}
                            onSelect={onBlockSelect}
                            onEnter={(id) => addBlockAfter(id, { kind: 'p', value: '' })}
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
                      onClick={() => addBlockAfter(null, { kind: 'p', value: '' })}
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
                      <div className="dt-ed2pvgrid">
                        <PreviewPaper content={inline.content} map={map} className="dt-ed2paper" testId="rtr-inline-preview-paper" />
                        {inline.content.samples != null && inline.content.samples.length > 0 ? <SampleValues samples={inline.content.samples} compact /> : null}
                      </div>
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
                    {settingsFacts.map((f) => (
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
          · {blockReason !== '' ? blockReason : canApprove ? 'Ready to approve' : 'Ready for approval by an owner or administrator'}
        </span>
        <span className="dt-footer__acts">
          <Button unstyled className="dt-link dt-link--danger dt-nowrap" onClick={() => setDiscardOpen(true)} disabled={busy} data-testid="rtr-editor-discard">Discard draft</Button>
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--ic dt-nowrap" onClick={() => void openPreviewModal()} disabled={busy} data-testid="rtr-editor-preview"><EyeIcon />Preview</Button>
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--ic dt-nowrap" onClick={() => void save()} disabled={busy || !dirty} data-testid="rtr-editor-save"><SaveIcon />Save draft</Button>
          {canApprove ? (
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
          ) : null}
        </span>
      </div>

      {modal != null ? <PreviewModal content={modal} map={map} onClose={() => setModal(null)} /> : null}
      {approveOpen && canApprove ? (
        <ApproveModal draftVersion={draft.n} activeVersion={activeN} busy={busy} onCancel={() => setApproveOpen(false)} onApprove={() => void approve()} />
      ) : null}
      {discardOpen ? (
        <DiscardModal draftVersion={draft.n} busy={busy} onCancel={() => setDiscardOpen(false)} onDiscard={() => void discard()} />
      ) : null}
    </div>
  );
}
