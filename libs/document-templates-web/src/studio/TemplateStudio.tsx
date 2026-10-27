import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@aramo/fe-foundation';

import { Letterhead, SafeDoc, type LetterheadInfo } from '../dt-html-render';
import { bindingMapFrom } from '../dt-ui';
import {
  STUDIO_LETTERHEAD_KIND,
  createStudioCodec,
  studioBlocksFromHtml,
  studioLetterheadState,
  studioPlainText,
  studioVariableKeys,
  type StudioLetterheadState,
} from '../studio-codec';

import {
  DEFAULT_STUDIO_CONTENT_CODEC,
  STUDIO_HTML_CONTENT_VERSION as HTML_CONTENT_VERSION,
  studioHtmlContentOf as htmlContentOf,
  withdrawalStateOf,
  type StudioContentCodec,
  type StudioSamplePreview as SamplePreview,
  type StudioTemplate as TemplateDetail,
  type StudioVersion as TemplateVersion,
  type TemplateStudioContext,
  type TemplateStudioDataSource,
} from './data-source';
import { formatDate, formatDateRelative } from './format-date';
import { Pill, SkeletonPanel } from './primitives';
import { blockDiff, diffStats, type DiffBlock } from './diff';
import { appendVariable, cloneBlocks, insertBlocks, makeBlock, moveBlock, newBlockId, removeVariableEverywhere, type StudioDoc } from './doc-ops';
import { deriveReadiness } from './readiness';
import { StudioCanvas, type CanvasHandle } from './StudioCanvas';
import { StudioInspector, type PropertiesPatch, type RightTab } from './StudioInspector';
import { StudioLeftPanel, type LeftTab, type SectionCardModel, type VersionRowModel } from './StudioLeftPanel';
import { StudioPreview, orgNameOf, type PreviewSource } from './StudioPreview';
import { StudioTopBar, type SaveState, type StudioMode } from './StudioTopBar';
import { CancelWithdrawalDialog, DiscardDialog, PublishDialog, RestoreDialog, ShortcutsSheet, WithdrawDialog } from './studio-dialogs';
import { useStudioDoc } from './use-studio-doc';
import { useStudioDrag, type DragPayload, type DropPos } from './use-studio-drag';
import { VersionDiff, type DiffSide } from './VersionDiff';
import { EMPTY_CATALOG, buildCatalog, chipInfo, type VariableCatalog } from './variables';
import './studio.css';

// PLATFORM-UX-1 F-9 (handoff §10; directive R-10–R-13) — the Template Studio (platform:
// /document-templates/:id, R-12). TEMPLATE-STUDIO-1 S-0: ONE shared component for Platform
// Admin and Organization — every read, write, capability and context-specific line of copy
// comes through the `dataSource` adapter (./data-source); the host injects its account
// menu, its breadcrumb setter and its error formatter. Left panel 272 /
// canvas 1fr / inspector 328; the left panel becomes an overlay below 1280px and the
// inspector below 1100px. Workflow (§10.7): save draft (⌘S, 3s debounced autosave),
// preview (saves first; the existing preview endpoint), derived readiness checks,
// publish vN, versions (view, compare, restore), withdraw / cancel withdrawal,
// properties. Read-only viewers see the published version in Preview only (R-13).

const AUTOSAVE_MS = 3000;
const TOAST_MS = 3500;
const LEFT_BP = 1280;
const RIGHT_BP = 1100;
const WIDE_BP = 1200;

function viewportWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1440;
}

function clockNow(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function defaultErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message !== '' ? e.message : fallback;
}

function draftOf(d: TemplateDetail | null): TemplateVersion | null {
  return d?.versions.find((v) => v.status === 'DRAFT') ?? null;
}
function currentOf(d: TemplateDetail | null): TemplateVersion | null {
  if (d === null || d.current_version === null) return null;
  return d.versions.find((v) => v.id === d.current_version?.id) ?? null;
}
function contentDoc(v: TemplateVersion | null, content: StudioContentCodec): StudioDoc | null {
  const c = v !== null ? htmlContentOf(v) : null;
  if (c === null) return null;
  const { blocks, letterhead } = content.decode(c.html, newBlockId);
  return letterhead !== null ? { title: c.title, blocks, letterhead } : { title: c.title, blocks };
}
function diffBlocksOf(blocks: StudioDoc['blocks']): DiffBlock[] {
  return blocks.map((b) => ({ kind: b.kind, text: studioPlainText(b.value) }));
}
/** What the host's account slot receives (TEMPLATE-STUDIO-1 S-0). */
export interface StudioAccountSlot {
  /** Shown in the menu while there are unsaved changes. */
  readonly notice: string | undefined;
  /** Saves unsaved changes, then runs `go` (switch account, sign out). */
  readonly beforeLeave: (go: () => void) => Promise<void>;
}

export interface TemplateStudioProps {
  readonly context: TemplateStudioContext;
  readonly dataSource: TemplateStudioDataSource;
  readonly templateId: string;
  /** The host's account menu (top bar, right). */
  readonly renderAccount?: (slot: StudioAccountSlot) => ReactNode;
  /** The host's breadcrumb setter: the template name once loaded, null on unmount. */
  readonly onEntityName?: (name: string | null) => void;
  /** The host's refusal → message formatter. Default: the error's message. */
  readonly formatError?: (e: unknown, fallback: string) => string;
  /**
   * TEMPLATE-STUDIO-1 S-2 — host actions in the top bar (the gallery preview's Adopt). A
   * function receives the Studio's version state (the Org Studio's "Create new version").
   */
  readonly actions?: ReactNode | ((state: StudioHostActionState) => ReactNode);
}

/**
 * TEMPLATE-STUDIO-1 (directive §1.4, §3.4) — what a host's top-bar action can read and do:
 * the open draft and the approved version, and `createDraft` — opens the draft from the
 * editor's content through the data source's createDraft (organization: POST /:id/draft,
 * which copies the ACTIVE version and its logo reference) and switches to Edit.
 */
export interface StudioHostActionState {
  readonly canEdit: boolean;
  readonly draft: { readonly version_number: number } | null;
  readonly current: { readonly version_number: number } | null;
  /** The draft's number, else the next version number. */
  readonly nextVersion: number;
  /** A save or draft creation is in flight. */
  readonly busy: boolean;
  readonly createDraft: () => Promise<boolean>;
}

/** TEMPLATE-STUDIO-1 S-1 (A1) — why a save is held back while letterhead node and logo disagree. */
export const LETTERHEAD_SAVE_BLOCKED: Readonly<Record<Exclude<StudioLetterheadState, 'ok'>, string>> = {
  node_missing:
    'Can’t save yet: the tenant logo was taken out of this content, but the draft still holds it. Put the logo back, or remove it from the letterhead.',
  asset_missing:
    'Can’t save yet: this content has a letterhead logo that isn’t captured for this draft. Add the tenant logo, or take the letterhead out.',
};

export function TemplateStudio({ context, dataSource: ds, templateId, renderAccount, onEntityName, formatError = defaultErrorMessage, actions }: TemplateStudioProps) {
  // canManage = may edit the draft (the platform's :manage); approval is its own capability.
  const { canEdit: canManage, canApprove } = ds.capabilities;
  const copy = ds.copy;
  const content = ds.content ?? DEFAULT_STUDIO_CONTENT_CODEC;
  const templateErrorMessage = formatError;
  const hasWithdrawal = ds.withdraw !== undefined;
  const showVersions = ds.capabilities.versions !== false;
  const lhApi = ds.letterhead;
  const versionPill = (v: TemplateVersion) => (v.status === 'ACTIVE' ? copy.versionActive : copy.versionRetired);
  const location = useLocation();
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [docTypeName, setDocTypeName] = useState('');
  const [catalog, setCatalog] = useState<VariableCatalog>(EMPTY_CATALOG);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(() => {
    const st = location.state as { copyError?: unknown } | null;
    return typeof st?.copyError === 'string' ? st.copyError : null;
  });

  const docState = useStudioDoc({ title: '', blocks: [] });
  const { doc, change, editRev } = docState;
  const [savedEditRev, setSavedEditRev] = useState(0);
  const [draft, setDraft] = useState<TemplateVersion | null>(null);
  const [savedRev, setSavedRev] = useState(0);
  const [previewedRev, setPreviewedRev] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<{ at: string; auto: boolean } | null>(null);
  const [autosave, setAutosave] = useState(true);
  // Synchronous mirrors of the save state (read after an await, before React re-renders).
  const draftRef = useRef<TemplateVersion | null>(null);
  const savedEditRevRef = useRef(0);
  const savedRevRef = useRef(0);

  const [mode, setMode] = useState<StudioMode>(canManage ? 'edit' : 'preview');
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SamplePreview | null>(null);
  const [pvLoading, setPvLoading] = useState(false);
  const [pvError, setPvError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [zoom, setZoom] = useState(100);
  // The editor's block heights as Preview opens: page breaks follow them (handoff §10.7).
  const [blockHeights, setBlockHeights] = useState<number[] | null>(null);

  const [width, setWidth] = useState(viewportWidth);
  const [leftOpen, setLeftOpen] = useState(() => viewportWidth() >= LEFT_BP);
  const [rightOpen, setRightOpen] = useState(() => viewportWidth() >= RIGHT_BP);
  const [leftTab, setLeftTab] = useState<LeftTab>('outline');
  const [rightTab, setRightTab] = useState<RightTab>('variables');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [cancelWdOpen, setCancelWdOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [tenantLogo, setTenantLogo] = useState<{ readonly available: boolean; readonly tenant_name: string } | null>(null);
  // S-2 — the read-only Preview's server render of the current version (previewCurrent).
  const [readerPreview, setReaderPreview] = useState<SamplePreview | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [compare, setCompare] = useState<{ left: string; right: string; changesOnly: boolean } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const canvasRef = useRef<CanvasHandle | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((m: string) => {
    window.clearTimeout(toastTimer.current);
    setToastMsg(m);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), TOAST_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const entityName = detail?.name ?? null;
  useEffect(() => {
    onEntityName?.(entityName);
    return () => onEntityName?.(null);
  }, [entityName, onEntityName]);

  // ── load ──────────────────────────────────────────────────────────────
  const { reset } = docState;
  const initDoc = useCallback(
    (d: TemplateDetail) => {
      const dv = draftOf(d);
      const cur = currentOf(d);
      const fromDraft = dv !== null ? contentDoc(dv, content) : null;
      const base: StudioDoc = canManage
        ? (fromDraft ?? contentDoc(cur, content) ?? { title: d.name, blocks: [] })
        : (contentDoc(cur, content) ?? { title: d.name, blocks: [] });
      reset(base);
      savedEditRevRef.current = 0;
      setSavedEditRev(0);
      draftRef.current = dv;
      setDraft(dv);
      savedRevRef.current = 0;
      setSavedRev(0);
      setPreviewedRev(dv !== null && dv.previewed_fingerprint !== null && dv.previewed_fingerprint === dv.content_fingerprint ? 0 : null);
      if (dv !== null && fromDraft === null && canManage) setBanner('This draft uses an earlier content format. Saving it here converts it to the Studio format.');
    },
    [canManage, reset, content],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [d, cat] = await Promise.all([ds.load(templateId), ds.catalog(templateId)]);
        if (!live) return;
        setCatalog(buildCatalog(cat.variables, cat.bindings));
        setTenantLogo(cat.tenantLogo ?? null);
        setDocTypeName(cat.documentTypes?.find((t) => t.id === d.document_type_id)?.name ?? d.document_type_id);
        setDetail(d);
        initDoc(d);
      } catch (e) {
        if (live) setLoadError(templateErrorMessage(e, 'Failed to load the template.'));
      }
    })();
    return () => {
      live = false;
    };
  }, [ds, templateId, initDoc, templateErrorMessage]);

  const refreshDetail = useCallback(async (): Promise<TemplateDetail | null> => {
    try {
      const d = await ds.load(templateId);
      setDetail(d);
      return d;
    } catch {
      return null;
    }
  }, [ds, templateId]);

  // ── responsive panels (handoff §10.2) ─────────────────────────────────
  useEffect(() => {
    let prev = viewportWidth();
    const onResize = (): void => {
      const w = window.innerWidth;
      if (w < LEFT_BP && prev >= LEFT_BP) setLeftOpen(false);
      if (w >= LEFT_BP && prev < LEFT_BP) setLeftOpen(true);
      if (w < RIGHT_BP && prev >= RIGHT_BP) setRightOpen(false);
      if (w >= RIGHT_BP && prev < RIGHT_BP) setRightOpen(true);
      prev = w;
      setWidth(w);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── derived ───────────────────────────────────────────────────────────
  const dirty = editRev !== savedEditRev;
  const withdrawal = detail !== null ? withdrawalStateOf(detail) : 'NONE';
  const current = currentOf(detail);
  const currentDoc = useMemo(() => contentDoc(current, content), [current, content]);
  const codec = useMemo(() => createStudioCodec((k) => chipInfo(catalog, k)), [catalog]);
  const map = useMemo(() => bindingMapFrom(catalog.list.map((v) => ({ key: v.key, label: v.label }))), [catalog]);
  const readiness = useMemo(
    () =>
      deriveReadiness({
        title: doc.title,
        blocks: doc.blocks,
        chipState: (k) => chipInfo(catalog, k).state,
        dirty,
        savedRev,
        previewedRev,
        withdrawal: hasWithdrawal ? withdrawal : null,
        unknownDetail: copy.unknownVariableDetail,
      }),
    [doc, catalog, dirty, savedRev, previewedRev, withdrawal, hasWithdrawal, copy.unknownVariableDetail],
  );
  const editable = canManage && mode === 'edit';
  const wide = width >= WIDE_BP;
  const nextVersion =
    draft?.version_number ?? (detail !== null && detail.versions.length > 0 ? Math.max(...detail.versions.map((v) => v.version_number)) + 1 : 1);
  const publishedNumber = detail?.current_version?.version_number ?? null;
  const published = detail !== null && detail.status === 'ACTIVE' && detail.current_version !== null;
  const canWithdraw = ds.capabilities.canWithdraw && ds.withdraw !== undefined && withdrawal === 'NONE' && published;
  const canCancelWithdrawal = ds.capabilities.canWithdraw && ds.cancelWithdrawal !== undefined && withdrawal === 'PENDING';
  const canDiscard = canManage && ds.discardDraft !== undefined && draft !== null;
  // S-1 (A1) — the server-owned logo reference the letterhead node must agree with: the
  // open draft's, or (no draft yet) the active version's, which POST …/:id/draft copies.
  const logoRef = draft !== null ? (draft.logo ?? null) : (current?.logo ?? null);
  const logoVersionId = draft?.id ?? current?.id ?? null;
  const lhState: StudioLetterheadState = lhApi !== undefined ? studioLetterheadState(doc.letterhead ? [doc.letterhead] : [], logoRef) : 'ok';
  const lhRef = useRef({ logoRef, enabled: lhApi !== undefined });
  lhRef.current = { logoRef, enabled: lhApi !== undefined };

  // ── save (⌘S · autosave) ──────────────────────────────────────────────
  const latest = useRef({ doc, editRev });
  latest.current = { doc, editRev };
  const inflight = useRef<Promise<boolean> | null>(null);

  const saveDraft = useCallback(
    (auto: boolean, skipLetterheadCheck = false): Promise<boolean> => {
      if (!canManage) return Promise.resolve(false);
      if (inflight.current !== null) return inflight.current;
      const { doc: d, editRev: rev } = latest.current;
      const dv = draftRef.current;
      if (rev === savedEditRevRef.current && dv !== null) return Promise.resolve(true);
      if (lhRef.current.enabled && !skipLetterheadCheck) {
        const st = studioLetterheadState(d.letterhead ? [d.letterhead] : [], lhRef.current.logoRef);
        if (st !== 'ok') {
          setBanner(LETTERHEAD_SAVE_BLOCKED[st]);
          return Promise.resolve(false);
        }
      }
      const field_schema = { render_schema_version: HTML_CONTENT_VERSION, title: d.title.trim(), html: content.encode(d.blocks, d.letterhead ?? null) };
      setSaving(true);
      const p = (async () => {
        try {
          const v =
            dv !== null
              ? await ds.saveDraft(dv.id, { render_schema_version: HTML_CONTENT_VERSION, field_schema })
              : await ds.createDraft(templateId, { render_schema_version: HTML_CONTENT_VERSION, field_schema });
          draftRef.current = v;
          setDraft(v);
          savedEditRevRef.current = rev;
          setSavedEditRev(rev);
          savedRevRef.current += 1;
          setSavedRev(savedRevRef.current);
          setSavedAt({ at: clockNow(), auto });
          setBanner(null);
          if (!auto) toast('Draft saved.');
          return true;
        } catch (e) {
          setBanner(templateErrorMessage(e, 'Could not save the draft.'));
          return false;
        } finally {
          setSaving(false);
          inflight.current = null;
        }
      })();
      inflight.current = p;
      return p;
    },
    [canManage, templateId, toast, ds, content, templateErrorMessage],
  );

  useEffect(() => {
    if (!canManage || !autosave || !dirty) return undefined;
    const t = window.setTimeout(() => void saveDraft(true), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [editRev, autosave, dirty, canManage, saveDraft]);

  useEffect(() => {
    if (!dirty || !canManage) return undefined;
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty, canManage]);

  // ── preview (saves first) ─────────────────────────────────────────────
  const enterPreview = useCallback(async () => {
    const editors = Array.from(document.querySelectorAll<HTMLElement>('.pws-doc [data-block-id]'));
    if (editors.length > 0) setBlockHeights(editors.map((el) => el.offsetHeight));
    setMode('preview');
    setViewVersionId(null);
    if (!canManage) return;
    setPvLoading(true);
    setPvError(null);
    if (latest.current.editRev !== savedEditRevRef.current || draftRef.current === null) {
      const ok = await saveDraft(true);
      if (!ok) {
        setPvLoading(false);
        setPvError('Save the draft before previewing: the save didn’t go through.');
        return;
      }
    }
    const id = draftRef.current?.id;
    if (id === undefined) {
      setPvLoading(false);
      return;
    }
    try {
      const res = await ds.preview(id);
      setPreview(res);
      setPreviewedRev(savedRevRef.current);
    } catch (e) {
      setPreview(null);
      setPvError(templateErrorMessage(e, 'Preview failed.'));
    } finally {
      setPvLoading(false);
    }
  }, [canManage, saveDraft, ds, templateErrorMessage]);

  // TEMPLATE-STUDIO-1 (§3.4) — a host's explicit "Create new version": the draft opens from
  // the editor's content (unsaved edits included) and the Studio switches to Edit.
  const createDraftNow = useCallback(async (): Promise<boolean> => {
    if (!canManage) return false;
    if (draftRef.current !== null) {
      setMode('edit');
      setViewVersionId(null);
      return true;
    }
    const ok = await saveDraft(true);
    const v = draftRef.current as TemplateVersion | null;
    if (ok && v !== null) {
      setMode('edit');
      setViewVersionId(null);
      toast(`Draft v${v.version_number} created. Nothing changes until it’s approved.`);
    }
    return ok;
  }, [canManage, saveDraft, toast]);

  const switchMode = (m: 'edit' | 'preview'): void => {
    if (m === 'preview') void enterPreview();
    else if (canManage) {
      setMode('edit');
      setViewVersionId(null);
    }
  };

  // ── global keys (⌘S · ⌘⇧P · ?) ────────────────────────────────────────
  const keyState = useRef({ mode, enterPreview, saveDraft });
  keyState.current = { mode, enterPreview, saveDraft };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inField = t !== null && (t.isContentEditable || t.closest('[contenteditable="true"]') !== null || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void keyState.current.saveDraft(false);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (keyState.current.mode === 'preview') {
          if (canManage) setMode('edit');
        } else void keyState.current.enterPreview();
      } else if (e.key === '?' && !inField && !mod) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canManage]);

  // ── drag and drop ─────────────────────────────────────────────────────
  const onDrop = useCallback(
    (p: DragPayload, target: string | null, pos: DropPos) => {
      if (!canManage) return;
      if (p.kind === 'block') {
        change((d) => ({ ...d, blocks: moveBlock(d.blocks, p.id, target, pos) }));
      } else if (target !== null) {
        change((d) => ({ ...d, blocks: appendVariable(d.blocks, target, p.key) }));
        toast(`Inserted {{${p.key}}}.`);
      } else {
        const nb = { ...makeBlock('p'), value: `<span data-field="${p.key}"></span>` };
        change((d) => ({ ...d, blocks: insertBlocks(d.blocks, [nb], null) }));
        toast(`Inserted {{${p.key}}}.`);
      }
    },
    [canManage, change, toast],
  );
  const drag = useStudioDrag(onDrop);

  // ── actions ───────────────────────────────────────────────────────────
  const openChecks = (): void => {
    setRightOpen(true);
    setRightTab('checks');
  };
  const openSections = (): void => {
    setLeftOpen(true);
    setLeftTab('sections');
  };
  const removeVar = (key: string): void => {
    change((d) => ({ ...d, blocks: removeVariableEverywhere(d.blocks, key) }));
    toast(`Removed {{${key}}} from the draft.`);
  };
  const copyPublished = (): void => {
    const src = currentDoc;
    if (src === null) return;
    change((d) => ({ ...d, blocks: cloneBlocks(src.blocks) }));
    toast(`Copied v${publishedNumber ?? ''} into the draft.`);
  };

  const runAction = async (fn: () => Promise<void>, fallback: string): Promise<boolean> => {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setActionError(templateErrorMessage(e, fallback));
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const doPublish = (): void => {
    void runAction(async () => {
      const dv = draftRef.current;
      if (dv === null) throw new Error('no draft');
      const v = await ds.approve(dv.id);
      setPublishOpen(false);
      draftRef.current = null;
      setDraft(null);
      setPreviewedRev(null);
      setPreview(null);
      setMode('edit');
      await refreshDetail();
      toast(copy.approveToast(v.version_number));
    }, copy.approveFailed);
  };

  const doWithdraw = (days: number, reason: string): void => {
    void runAction(async () => {
      if (ds.withdraw === undefined) throw new Error('withdrawal unavailable');
      const t = await ds.withdraw(templateId, { notice_days: days, reason });
      setWithdrawOpen(false);
      await refreshDetail();
      toast(days === 0 ? 'Template withdrawn.' : `Withdrawal scheduled for ${formatDate(t.withdraw_effective_at)}.`);
    }, 'Could not publish the withdrawal.');
  };

  const doCancelWithdrawal = (): void => {
    void runAction(async () => {
      if (ds.cancelWithdrawal === undefined) throw new Error('withdrawal unavailable');
      await ds.cancelWithdrawal(templateId);
      setCancelWdOpen(false);
      await refreshDetail();
      toast('Withdrawal cancelled.');
    }, 'Could not cancel the withdrawal.');
  };

  const saveProps = async (patch: PropertiesPatch): Promise<string | null> => {
    try {
      if (ds.updateProperties === undefined) return null;
      const t = await ds.updateProperties(templateId, patch);
      setDetail((d) => (d !== null ? { ...d, ...t, versions: d.versions } : d));
      return null;
    } catch (e) {
      return templateErrorMessage(e, 'Could not save the properties.');
    }
  };

  // ── discard draft (organization) ─────────────────────────────────────
  const reloadDraft = async (): Promise<void> => {
    const d = await ds.load(templateId);
    setDetail(d);
    initDoc(d);
    setPreview(null);
    setSavedAt(null);
  };
  const doDiscard = (): void => {
    void runAction(async () => {
      const dv = draftRef.current;
      if (dv === null || ds.discardDraft === undefined) throw new Error('no draft');
      await ds.discardDraft(dv.id);
      setDiscardOpen(false);
      setMode('edit');
      setViewVersionId(null);
      await reloadDraft();
      toast(`Draft v${dv.version_number} discarded.`);
    }, 'Could not discard the draft.');
  };

  // ── letterhead logo (organization, A1) ────────────────────────────────
  // Capture / remove always act on the DRAFT through the server (which places or strips
  // the node itself): save first (creating the draft if needed), call, then reload.
  const logoAction = async (kind: 'capture' | 'remove'): Promise<void> => {
    if (lhApi === undefined) return;
    if (latest.current.editRev !== savedEditRevRef.current || draftRef.current === null) {
      const ok = await saveDraft(true, true);
      if (!ok) return;
    }
    const id = draftRef.current?.id;
    if (id === undefined) return;
    try {
      if (kind === 'capture') await lhApi.capture(id);
      else await lhApi.remove(id);
      await reloadDraft();
      toast(kind === 'capture' ? 'Tenant logo added to the letterhead.' : 'Logo removed from the letterhead.');
    } catch (e) {
      setBanner(templateErrorMessage(e, kind === 'capture' ? 'Could not add the tenant logo.' : 'Could not remove the logo.'));
    }
  };

  // ── sections (organization, directive §7.2) ───────────────────────────
  const insertSection = (key: string): void => {
    const sec = ds.sections?.find((x) => x.key === key);
    if (sec === undefined || !editable) return;
    const add = studioBlocksFromHtml(sec.html, newBlockId);
    change((d) => ({ ...d, blocks: insertBlocks(d.blocks, add, selectedId) }));
    toast(`Inserted ${sec.name}.`);
  };

  const leave = async (go: () => void): Promise<void> => {
    if (canManage && latest.current.editRev !== savedEditRevRef.current) await saveDraft(true);
    go();
  };

  // ── sections (organization, directive §7.2): the static set's cards ───
  const sectionCards: SectionCardModel[] | undefined = useMemo(
    () =>
      ds.sections?.map((sec) => {
        const keys = Array.from(new Set(studioBlocksFromHtml(sec.html, newBlockId).flatMap((b) => studioVariableKeys(b.value))));
        return {
          key: sec.key,
          name: sec.name,
          description: sec.description,
          variables: keys.length,
          insertable: keys.every((k) => chipInfo(catalog, k).state === 'known'),
        };
      }),
    [ds.sections, catalog],
  );

  // ── read-only Preview of the current version (S-2: previewCurrent) ────
  const loaded = detail !== null;
  useEffect(() => {
    if (canManage || !loaded || ds.previewCurrent === undefined) return undefined;
    let live = true;
    setReaderLoading(true);
    ds.previewCurrent(templateId).then(
      (p) => {
        if (!live) return;
        setReaderPreview(p);
        setReaderLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setReaderError(templateErrorMessage(e, 'Preview failed.'));
        setReaderLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [canManage, loaded, ds, templateId, templateErrorMessage]);

  // ── versions + compare ────────────────────────────────────────────────
  const pastVersions = useMemo(
    () => (detail?.versions ?? []).filter((v) => v.status !== 'DRAFT').sort((a, b) => b.version_number - a.version_number),
    [detail],
  );
  const viewVersion = pastVersions.find((v) => v.id === viewVersionId) ?? null;
  const viewDoc = contentDoc(viewVersion, content);
  const versionRows: VersionRowModel[] = [
    {
      key: 'draft',
      n: 'Draft',
      pill: draft !== null || dirty ? { label: 'Open draft', tone: 'info' } : { label: 'No changes', tone: 'muted' },
      sub: `Updated ${formatDate(detail?.updated_at)}`,
      on: mode !== 'version',
    },
    ...pastVersions.map((v) => ({
      key: v.id,
      n: `v${v.version_number}`,
      pill: versionPill(v),
      sub: `${formatDate(v.activated_at ?? v.created_at)} · ${contentDoc(v, content)?.blocks.length ?? 0} blocks`,
      on: mode === 'version' && viewVersionId === v.id,
    })),
  ];
  const diffSides: DiffSide[] = [
    { key: 'draft', label: 'Draft', sub: 'Unpublished', blocks: diffBlocksOf(doc.blocks) },
    ...pastVersions.map((v) => ({
      key: v.id,
      label: `v${v.version_number}`,
      sub: `${versionPill(v).label} · ${formatDate(v.activated_at ?? v.created_at)}`,
      blocks: diffBlocksOf(contentDoc(v, content)?.blocks ?? []),
    })),
  ];
  const openCompare = (left?: string): void => {
    const l = left ?? (current !== null ? current.id : pastVersions[0]?.id ?? 'draft');
    setCompare({ left: l === 'draft' && current !== null ? current.id : l, right: 'draft', changesOnly: false });
  };
  const publishStats = publishOpen
    ? diffStats(blockDiff(diffBlocksOf(currentDoc?.blocks ?? []), diffBlocksOf(doc.blocks)))
    : { added: 0, changed: 0, removed: 0, unchanged: 0 };

  if (loadError !== null) {
    return (
      <div className="pws-root pws-root--msg" data-context={context}>
        <div role="alert" className="ts-alert ts-alert--error">
          {loadError}
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="pws-root pws-root--msg" data-context={context}>
        <SkeletonPanel label="Loading the template…" lines={['40%', '100%', '90%', '70%']} />
      </div>
    );
  }

  const saveState: SaveState = saving ? 'saving' : dirty ? 'unsaved' : 'saved';
  const saveLabel = saving ? 'Saving…' : dirty ? 'Unsaved changes' : `${savedAt?.auto === true ? 'Autosaved' : 'Saved'} · ${savedAt?.at ?? '—'}`;
  const leftOverlay = width < LEFT_BP;
  const rightOverlay = width < RIGHT_BP;
  const cols = `${leftOpen && !leftOverlay ? '272px ' : ''}minmax(0,1fr)${rightOpen && !rightOverlay ? ' 328px' : ''}`;
  const headings = doc.blocks.filter((b) => b.kind === 'h2').length;

  const readerSource: PreviewSource | null = (() => {
    if (readerPreview !== null) {
      return {
        title: readerPreview.title,
        html: readerPreview.html ?? '',
        mode: 'sample',
        version: `v${current?.version_number ?? ''}`,
        org: readerPreview.org ?? orgNameOf(readerPreview),
      };
    }
    if (ds.previewCurrent !== undefined) return null;
    const c = current !== null ? htmlContentOf(current) : null;
    return c !== null ? { title: c.title, html: c.html, mode: 'content', version: `v${current?.version_number ?? ''}`, org: '' } : null;
  })();
  const draftSource: PreviewSource | null =
    preview !== null
      ? { title: preview.title, html: preview.html ?? '', mode: 'sample', version: `Draft · v${draft?.version_number ?? nextVersion}`, org: preview.org ?? orgNameOf(preview) }
      : null;
  const tenantName = tenantLogo?.tenant_name ?? '';
  const shownPreview = canManage ? preview : readerPreview;
  const previewVersionId = canManage ? (draft?.id ?? null) : (current?.id ?? null);
  const previewLetterhead: LetterheadInfo | null =
    lhApi !== undefined && shownPreview?.logo != null && previewVersionId !== null
      ? { src: lhApi.logoUrl(previewVersionId, shownPreview.logo.asset_id), tenantName }
      : null;
  const letterheadSlot: ReactNode =
    lhApi === undefined || !editable ? undefined : (
      <LetterheadSlot
        state={lhState}
        present={doc.letterhead != null}
        info={{ src: logoRef !== null && logoVersionId !== null ? lhApi.logoUrl(logoVersionId, logoRef.asset_id) : null, tenantName }}
        logoAvailable={tenantLogo?.available !== false}
        onCapture={() => void logoAction('capture')}
        onRemove={() => void logoAction('remove')}
        onPutBack={() => change((d) => ({ ...d, letterhead: { id: newBlockId(), kind: STUDIO_LETTERHEAD_KIND, value: '' } }))}
        onTakeOut={() => change((d) => ({ ...d, letterhead: null }))}
      />
    );

  return (
    <div className="pws-root" data-context={context}>
      <StudioTopBar
        name={detail.name}
        versionTag={publishedNumber !== null ? `v${publishedNumber}` : 'Not published'}
        canEdit={canManage}
        canApprove={canApprove}
        copy={copy}
        saveState={saveState}
        saveLabel={saveLabel}
        mode={mode}
        onMode={switchMode}
        readiness={readiness}
        wide={wide}
        onOpenChecks={openChecks}
        onCompare={() => openCompare()}
        showCompare={showVersions}
        onSave={() => void saveDraft(false)}
        dirty={dirty}
        nextVersion={nextVersion}
        onPublish={() => {
          if (!readiness.ready) {
            openChecks();
            return;
          }
          setActionError(null);
          setPublishOpen(true);
        }}
        canWithdraw={canWithdraw}
        canCancelWithdrawal={canCancelWithdrawal}
        onWithdraw={() => {
          setActionError(null);
          setWithdrawOpen(true);
        }}
        onCancelWithdrawal={() => {
          setActionError(null);
          setCancelWdOpen(true);
        }}
        autosave={autosave}
        onToggleAutosave={() => setAutosave((a) => !a)}
        onShortcuts={() => setShortcutsOpen(true)}
        account={renderAccount?.({ notice: dirty ? "You have unsaved changes. They're saved before you sign out." : undefined, beforeLeave: leave })}
        onDiscard={
          canDiscard
            ? () => {
                setActionError(null);
                setDiscardOpen(true);
              }
            : undefined
        }
        actions={
          typeof actions === 'function'
            ? actions({
                canEdit: canManage,
                draft: draft !== null ? { version_number: draft.version_number } : null,
                current: publishedNumber !== null ? { version_number: publishedNumber } : null,
                nextVersion,
                busy: saving,
                createDraft: createDraftNow,
              })
            : actions
        }
      />

      {withdrawal === 'PENDING' ? (
        <div role="status" className="pws-bar pws-bar--warn">
          <b>Withdrawal pending.</b> Takes effect {formatDateRelative(detail.withdraw_effective_at)}.
          {canCancelWithdrawal ? (
            <Button
              unstyled
              className="pws-bar__btn"
              onClick={() => {
                setActionError(null);
                setCancelWdOpen(true);
              }}
            >
              Cancel withdrawal
            </Button>
          ) : null}
        </div>
      ) : null}
      {!canManage ? (
        <div className="pws-bar pws-bar--ro">{copy.viewOnly}</div>
      ) : null}
      {banner !== null ? (
        <div role="alert" className="pws-bar pws-bar--err">
          {banner}
          <Button unstyled className="pws-bar__x" aria-label="Dismiss" onClick={() => setBanner(null)}>
            ×
          </Button>
        </div>
      ) : null}

      <div className="pws-grid" style={{ gridTemplateColumns: cols }}>
        {leftOpen ? (
          <StudioLeftPanel
            tab={leftTab}
            onTab={setLeftTab}
            blocks={doc.blocks}
            headings={headings}
            variables={readiness.used.size}
            selectedId={selectedId}
            editable={editable}
            onGo={(id) => {
              setSelectedId(id);
              if (editable) canvasRef.current?.focusBlock(id);
            }}
            drag={drag}
            versions={versionRows}
            onView={(key) => {
              if (key === 'draft') {
                setViewVersionId(null);
                setMode(canManage ? 'edit' : 'preview');
              } else {
                setViewVersionId(key);
                setMode('version');
              }
            }}
            onCompare={(key) => openCompare(key)}
            overlay={leftOverlay}
            sections={sectionCards}
            onInsertSection={insertSection}
            showVersions={showVersions}
          />
        ) : null}

        <div className="pws-center">
          {mode === 'version' && viewVersion !== null ? (
            <section aria-label="Version" className="pws-doc">
              <div className="pws-bar pws-bar--info pws-vbar">
                <b>Viewing v{viewVersion.version_number}</b>
                <span className="pws-pill20">
                  <Pill tone={versionPill(viewVersion).tone} dot={false}>
                    {versionPill(viewVersion).label}
                  </Pill>
                </span>
                {/* Three flex items, 10px apart, as in the design's bar. */}
                <span>Published</span>
                <span>{formatDate(viewVersion.activated_at ?? viewVersion.created_at)}</span>
                <span>· read only</span>
                <span className="pws-vbar__acts">
                  <Button unstyled className="pws-btn28" onClick={() => openCompare(viewVersion.id)}>
                    Compare with draft
                  </Button>
                  {canManage ? (
                    <Button unstyled className="pws-btn28" onClick={() => setRestoreOpen(true)}>
                      Restore into draft…
                    </Button>
                  ) : null}
                  <Button
                    unstyled
                    className="pws-btn28 pws-btn28--dark"
                    onClick={() => {
                      setViewVersionId(null);
                      setMode(canManage ? 'edit' : 'preview');
                    }}
                  >
                    Back to draft
                  </Button>
                </span>
              </div>
              <div className="pws-doc__scroll pws-doc__scroll--version" tabIndex={0} role="region" aria-label={`v${viewVersion.version_number} content`}>
                <div className="pws-page pws-page--ro">
                  <h1 className="pws-page__h1">{viewDoc?.title ?? ''}</h1>
                  {viewVersion !== null && htmlContentOf(viewVersion) !== null ? (
                    <SafeDoc html={htmlContentOf(viewVersion)?.html ?? ''} map={map} mode="content" letterhead={null} />
                  ) : (
                    <p className="pws-muted">This version uses an earlier content format and can’t be shown here.</p>
                  )}
                </div>
              </div>
            </section>
          ) : mode === 'preview' ? (
            <section aria-label="Preview" className="pws-doc">
              <StudioPreview
                source={canManage ? draftSource : readerSource}
                loading={canManage ? pvLoading : readerLoading}
                error={canManage ? pvError : readerError}
                emptyLabel={canManage ? 'Add content to the draft, then preview it.' : 'This template has no published version yet.'}
                templateId={detail.id}
                map={map}
                highlight={highlight}
                onHighlight={setHighlight}
                zoom={zoom}
                onZoom={setZoom}
                blockHeights={canManage ? blockHeights : null}
                letterhead={previewLetterhead}
              />
            </section>
          ) : (
            <StudioCanvas
              ref={canvasRef}
              doc={doc}
              change={change}
              undo={docState.undo}
              redo={docState.redo}
              canUndo={docState.canUndo}
              canRedo={docState.canRedo}
              catalog={catalog}
              codec={codec}
              selectedId={selectedId}
              onSelect={setSelectedId}
              canCopyPublished={current !== null && htmlContentOf(current) !== null}
              onCopyPublished={copyPublished}
              onOpenSections={openSections}
              onToggleLeft={() => setLeftOpen((o) => !o)}
              onToggleRight={() => setRightOpen((o) => !o)}
              toast={toast}
              drag={drag}
              letterhead={letterheadSlot}
            />
          )}
        </div>

        {rightOpen ? (
          <StudioInspector
            tab={rightTab}
            onTab={setRightTab}
            catalog={catalog}
            readiness={readiness}
            editable={editable}
            canEdit={canManage}
            canEditProps={canManage && ds.updateProperties !== undefined}
            showProductTags={ds.capabilities.productTags}
            showDescription={ds.capabilities.description}
            withdrawalEnabled={hasWithdrawal}
            manageVariables={copy.manageVariables}
            checksNote={copy.checksNote}
            variablesNote={copy.variablesNote}
            scopeCard={copy.scopeCard}
            onInsert={(key) => canvasRef.current?.insertVariable(key)}
            drag={drag}
            onFix={removeVar}
            template={detail}
            docTypeName={docTypeName}
            withdrawal={withdrawal}
            onSaveProps={saveProps}
            canWithdraw={canWithdraw}
            canCancelWithdrawal={canCancelWithdrawal}
            onWithdraw={() => {
              setActionError(null);
              setWithdrawOpen(true);
            }}
            onCancelWithdrawal={() => {
              setActionError(null);
              setCancelWdOpen(true);
            }}
            overlay={rightOverlay}
          />
        ) : null}
      </div>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        name={detail.name}
        next={nextVersion}
        current={publishedNumber}
        stats={publishStats}
        variables={readiness.used.size}
        warnings={readiness.warns}
        busy={actionBusy}
        error={actionError}
        onPublish={doPublish}
        copy={copy.approveDialog}
        warningsText={copy.approveWarnings}
      />
      {draft !== null && ds.discardDraft !== undefined ? (
        <DiscardDialog open={discardOpen} onOpenChange={setDiscardOpen} version={draft.version_number} busy={actionBusy} error={actionError} onConfirm={doDiscard} />
      ) : null}
      <WithdrawDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} name={detail.name} busy={actionBusy} error={actionError} onWithdraw={doWithdraw} />
      <CancelWithdrawalDialog open={cancelWdOpen} onOpenChange={setCancelWdOpen} busy={actionBusy} error={actionError} onConfirm={doCancelWithdrawal} />
      {viewVersion !== null ? (
        <RestoreDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          version={viewVersion.version_number}
          onConfirm={() => {
            const src = contentDoc(viewVersion, content);
            setRestoreOpen(false);
            if (src === null) return;
            change(() => ({ ...src, blocks: cloneBlocks(src.blocks) }));
            setViewVersionId(null);
            setMode('edit');
            toast(copy.restoreToast !== undefined ? copy.restoreToast(viewVersion.version_number) : `Draft replaced with v${viewVersion.version_number}. Save and preview before publishing.`);
          }}
        />
      ) : null}
      {compare !== null ? (
        <VersionDiff
          open
          onOpenChange={(o) => {
            if (!o) setCompare(null);
          }}
          sides={diffSides}
          left={compare.left}
          right={compare.right}
          onLeft={(left) => setCompare((c) => (c !== null ? { ...c, left } : c))}
          onRight={(right) => setCompare((c) => (c !== null ? { ...c, right } : c))}
          changesOnly={compare.changesOnly}
          onChangesOnly={(changesOnly) => setCompare((c) => (c !== null ? { ...c, changesOnly } : c))}
        />
      ) : null}
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {toastMsg !== null ? (
        <div role="status" className="pws-toast">
          {toastMsg}
        </div>
      ) : null}
    </div>
  );
}

/** TEMPLATE-STUDIO-1 S-1 (A1) — the letterhead slot at the top of the page (organization). */
function LetterheadSlot(p: {
  readonly state: StudioLetterheadState;
  readonly present: boolean;
  readonly info: LetterheadInfo;
  readonly logoAvailable: boolean;
  readonly onCapture: () => void;
  readonly onRemove: () => void;
  readonly onPutBack: () => void;
  readonly onTakeOut: () => void;
}) {
  if (p.state === 'node_missing') {
    return (
      <div className="pws-lh pws-lh--warn" role="alert" data-testid="studio-letterhead-warn">
        <span className="pws-lh__body">The tenant logo was taken out of this content, but the draft still holds it.</span>
        <span className="pws-lh__acts">
          <Button unstyled className="pws-btn26" onClick={p.onPutBack}>
            Put the logo back
          </Button>
          <Button unstyled className="pws-btn26" onClick={p.onRemove}>
            Remove logo
          </Button>
        </span>
      </div>
    );
  }
  if (p.state === 'asset_missing') {
    return (
      <div className="pws-lh pws-lh--warn" role="alert" data-testid="studio-letterhead-warn">
        <span className="pws-lh__body">This content has a letterhead logo that isn’t captured for this draft.</span>
        <span className="pws-lh__acts">
          <Button unstyled className="pws-btn26" disabled={!p.logoAvailable} onClick={p.onCapture}>
            Add tenant logo
          </Button>
          <Button unstyled className="pws-btn26" onClick={p.onTakeOut}>
            Take out letterhead
          </Button>
        </span>
      </div>
    );
  }
  if (p.present) {
    return (
      <div className="pws-lh" data-testid="studio-letterhead">
        <span className="pws-lh__body">
          <Letterhead info={p.info} variant="editor" />
        </span>
        <span className="pws-lh__acts">
          <Button unstyled className="pws-btn26" onClick={p.onRemove}>
            Remove logo
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className="pws-lh pws-lh--add" data-testid="studio-letterhead-add">
      <span>No letterhead logo.</span>
      <Button
        unstyled
        className="pws-btn26"
        disabled={!p.logoAvailable}
        title={p.logoAvailable ? 'Place the organization profile logo at the top of the document' : 'Add a logo to your organization profile first'}
        onClick={p.onCapture}
      >
        + Tenant logo
      </Button>
    </div>
  );
}
