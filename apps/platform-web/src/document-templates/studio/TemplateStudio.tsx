import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, hasScope, logout, redirectToLogin, type Session } from '@aramo/fe-foundation';
import {
  SafeDoc,
  bindingMapFrom,
  createStudioCodec,
  studioBlocksFromHtml,
  studioBlocksToHtml,
  studioPlainText,
} from '@aramo/document-templates-web';

import { Pill } from '../../components/Pill';
import { SkeletonPanel } from '../../components/Skeleton';
import { formatDate, formatDateRelative } from '../../components/format-date';
import { useIdentity } from '../../identity/identity';
import { useEntityCrumb } from '../../shell/crumbs';
import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  HTML_CONTENT_VERSION,
  documentTemplatesApi,
  htmlContentOf,
  withdrawalStateOf,
  type PlatformTemplateDetail,
  type SamplePreview,
  type TemplateVersion,
} from '../document-templates-api';
import { templateErrorMessage } from '../template-errors';

import { blockDiff, diffStats, type DiffBlock } from './diff';
import { appendVariable, cloneBlocks, insertBlocks, makeBlock, moveBlock, newBlockId, removeVariableEverywhere, type StudioDoc } from './doc-ops';
import { deriveReadiness } from './readiness';
import { StudioCanvas, type CanvasHandle } from './StudioCanvas';
import { StudioInspector, type PropertiesPatch, type RightTab } from './StudioInspector';
import { StudioLeftPanel, type LeftTab, type VersionRowModel } from './StudioLeftPanel';
import { StudioPreview, orgNameOf, type PreviewSource } from './StudioPreview';
import { StudioTopBar, type SaveState, type StudioMode } from './StudioTopBar';
import { CancelWithdrawalDialog, PublishDialog, RestoreDialog, ShortcutsSheet, WithdrawDialog } from './studio-dialogs';
import { useStudioDoc } from './use-studio-doc';
import { useStudioDrag, type DragPayload, type DropPos } from './use-studio-drag';
import { VersionDiff, type DiffSide } from './VersionDiff';
import { EMPTY_CATALOG, buildCatalog, chipInfo, type VariableCatalog } from './variables';
import './studio.css';

// PLATFORM-UX-1 F-9 (handoff §10; directive R-10–R-13) — the Template Studio at
// /document-templates/:id (it REPLACES the old detail view, R-12). Left panel 272 /
// canvas 1fr / inspector 328; the left panel becomes an overlay below 1280px and the
// inspector below 1100px. Workflow (§10.7): save draft (⌘S, 3s debounced autosave),
// preview (saves first; the existing preview endpoint), derived readiness checks,
// publish vN, versions (view, compare, restore), withdraw / cancel withdrawal,
// properties. `:read` operators see the published version in Preview only (R-13).

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

function draftOf(d: PlatformTemplateDetail | null): TemplateVersion | null {
  return d?.versions.find((v) => v.status === 'DRAFT') ?? null;
}
function currentOf(d: PlatformTemplateDetail | null): TemplateVersion | null {
  if (d === null || d.current_version === null) return null;
  return d.versions.find((v) => v.id === d.current_version?.id) ?? null;
}
function contentDoc(v: TemplateVersion | null): StudioDoc | null {
  const c = v !== null ? htmlContentOf(v) : null;
  return c !== null ? { title: c.title, blocks: studioBlocksFromHtml(c.html, newBlockId) } : null;
}
function diffBlocksOf(blocks: StudioDoc['blocks']): DiffBlock[] {
  return blocks.map((b) => ({ kind: b.kind, text: studioPlainText(b.value) }));
}
function versionPill(v: TemplateVersion) {
  return v.status === 'ACTIVE' ? ({ label: 'Published', tone: 'ok' } as const) : ({ label: 'Replaced', tone: 'muted' } as const);
}

export interface TemplateStudioProps {
  readonly session: Session;
  readonly templateId: string;
}

export function TemplateStudio({ session, templateId }: TemplateStudioProps) {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const identity = useIdentity();
  const location = useLocation();
  const [detail, setDetail] = useState<PlatformTemplateDetail | null>(null);
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

  const [width, setWidth] = useState(viewportWidth);
  const [leftOpen, setLeftOpen] = useState(() => viewportWidth() >= LEFT_BP);
  const [rightOpen, setRightOpen] = useState(() => viewportWidth() >= RIGHT_BP);
  const [leftTab, setLeftTab] = useState<LeftTab>('outline');
  const [rightTab, setRightTab] = useState<RightTab>('variables');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [cancelWdOpen, setCancelWdOpen] = useState(false);
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

  useEntityCrumb(detail?.name);

  // ── load ──────────────────────────────────────────────────────────────
  const { reset } = docState;
  const initDoc = useCallback(
    (d: PlatformTemplateDetail) => {
      const dv = draftOf(d);
      const cur = currentOf(d);
      const fromDraft = dv !== null ? contentDoc(dv) : null;
      const base: StudioDoc = canManage ? fromDraft ?? contentDoc(cur) ?? { title: d.name, blocks: [] } : contentDoc(cur) ?? { title: d.name, blocks: [] };
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
    [canManage, reset],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [d, b, vars, types] = await Promise.all([
          documentTemplatesApi.getTemplate(templateId),
          documentTemplatesApi.allowedBindings(templateId),
          documentTemplatesApi.listVariables().catch(() => ({ variables: [] })),
          documentTemplatesApi.listDocumentTypes().catch(() => ({ document_types: [] })),
        ]);
        if (!live) return;
        setCatalog(buildCatalog(vars.variables, b.bindings));
        setDocTypeName(types.document_types.find((t) => t.id === d.document_type_id)?.name ?? d.document_type_id);
        setDetail(d);
        initDoc(d);
      } catch (e) {
        if (live) setLoadError(templateErrorMessage(e, 'Failed to load the template.'));
      }
    })();
    return () => {
      live = false;
    };
  }, [templateId, initDoc]);

  const refreshDetail = useCallback(async (): Promise<PlatformTemplateDetail | null> => {
    try {
      const d = await documentTemplatesApi.getTemplate(templateId);
      setDetail(d);
      return d;
    } catch {
      return null;
    }
  }, [templateId]);

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
        withdrawal,
      }),
    [doc, catalog, dirty, savedRev, previewedRev, withdrawal],
  );
  const editable = canManage && mode === 'edit';
  const wide = width >= WIDE_BP;
  const nextVersion =
    draft?.version_number ?? (detail !== null && detail.versions.length > 0 ? Math.max(...detail.versions.map((v) => v.version_number)) + 1 : 1);
  const publishedNumber = detail?.current_version?.version_number ?? null;
  const published = detail !== null && detail.status === 'ACTIVE' && detail.current_version !== null;
  const canWithdraw = canManage && withdrawal === 'NONE' && published;
  const canCancelWithdrawal = canManage && withdrawal === 'PENDING';

  // ── save (⌘S · autosave) ──────────────────────────────────────────────
  const latest = useRef({ doc, editRev });
  latest.current = { doc, editRev };
  const inflight = useRef<Promise<boolean> | null>(null);

  const saveDraft = useCallback(
    (auto: boolean): Promise<boolean> => {
      if (!canManage) return Promise.resolve(false);
      if (inflight.current !== null) return inflight.current;
      const { doc: d, editRev: rev } = latest.current;
      const dv = draftRef.current;
      if (rev === savedEditRevRef.current && dv !== null) return Promise.resolve(true);
      const field_schema = { render_schema_version: HTML_CONTENT_VERSION, title: d.title.trim(), html: studioBlocksToHtml(d.blocks) };
      setSaving(true);
      const p = (async () => {
        try {
          const v =
            dv !== null
              ? await documentTemplatesApi.updateDraft(dv.id, { render_schema_version: HTML_CONTENT_VERSION, field_schema })
              : await documentTemplatesApi.createDraft(templateId, { render_schema_version: HTML_CONTENT_VERSION, field_schema });
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
    [canManage, templateId, toast],
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
      const res = await documentTemplatesApi.preview(id);
      setPreview(res);
      setPreviewedRev(savedRevRef.current);
    } catch (e) {
      setPreview(null);
      setPvError(templateErrorMessage(e, 'Preview failed.'));
    } finally {
      setPvLoading(false);
    }
  }, [canManage, saveDraft]);

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
    const src = contentDoc(current);
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
      const v = await documentTemplatesApi.publish(dv.id);
      setPublishOpen(false);
      draftRef.current = null;
      setDraft(null);
      setPreviewedRev(null);
      setPreview(null);
      setMode('edit');
      await refreshDetail();
      toast(`v${v.version_number} published. Tenants now get this version.`);
    }, 'Publish failed.');
  };

  const doWithdraw = (days: number, reason: string): void => {
    void runAction(async () => {
      const t = await documentTemplatesApi.withdraw(templateId, { notice_days: days, reason });
      setWithdrawOpen(false);
      await refreshDetail();
      toast(days === 0 ? 'Template withdrawn.' : `Withdrawal scheduled for ${formatDate(t.withdraw_effective_at)}.`);
    }, 'Could not publish the withdrawal.');
  };

  const doCancelWithdrawal = (): void => {
    void runAction(async () => {
      await documentTemplatesApi.cancelWithdrawal(templateId);
      setCancelWdOpen(false);
      await refreshDetail();
      toast('Withdrawal cancelled.');
    }, 'Could not cancel the withdrawal.');
  };

  const saveProps = async (patch: PropertiesPatch): Promise<string | null> => {
    try {
      const t = await documentTemplatesApi.updateTemplate(templateId, patch);
      setDetail((d) => (d !== null ? { ...d, ...t, versions: d.versions } : d));
      return null;
    } catch (e) {
      return templateErrorMessage(e, 'Could not save the properties.');
    }
  };

  const leave = async (go: () => void): Promise<void> => {
    if (canManage && latest.current.editRev !== savedEditRevRef.current) await saveDraft(true);
    go();
  };

  // ── versions + compare ────────────────────────────────────────────────
  const pastVersions = useMemo(
    () => (detail?.versions ?? []).filter((v) => v.status !== 'DRAFT').sort((a, b) => b.version_number - a.version_number),
    [detail],
  );
  const viewVersion = pastVersions.find((v) => v.id === viewVersionId) ?? null;
  const viewDoc = contentDoc(viewVersion);
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
      sub: `${formatDate(v.activated_at ?? v.created_at)} · ${contentDoc(v)?.blocks.length ?? 0} blocks`,
      on: mode === 'version' && viewVersionId === v.id,
    })),
  ];
  const diffSides: DiffSide[] = [
    { key: 'draft', label: 'Draft', sub: 'Unpublished', blocks: diffBlocksOf(doc.blocks) },
    ...pastVersions.map((v) => ({
      key: v.id,
      label: `v${v.version_number}`,
      sub: `${versionPill(v).label} · ${formatDate(v.activated_at ?? v.created_at)}`,
      blocks: diffBlocksOf(contentDoc(v)?.blocks ?? []),
    })),
  ];
  const openCompare = (left?: string): void => {
    const l = left ?? (current !== null ? current.id : pastVersions[0]?.id ?? 'draft');
    setCompare({ left: l === 'draft' && current !== null ? current.id : l, right: 'draft', changesOnly: false });
  };
  const publishStats = publishOpen
    ? diffStats(blockDiff(diffBlocksOf(contentDoc(current)?.blocks ?? []), diffBlocksOf(doc.blocks)))
    : { added: 0, changed: 0, removed: 0, unchanged: 0 };

  if (loadError !== null) {
    return (
      <div className="pws-root pws-root--msg">
        <div role="alert" className="pw-alert pw-alert--error">
          {loadError}
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="pws-root pws-root--msg">
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
    const c = current !== null ? htmlContentOf(current) : null;
    return c !== null ? { title: c.title, html: c.html, mode: 'content', version: `v${current?.version_number ?? ''}`, org: '' } : null;
  })();
  const draftSource: PreviewSource | null =
    preview !== null
      ? { title: preview.title, html: preview.html ?? '', mode: 'sample', version: `Draft · v${draft?.version_number ?? nextVersion}`, org: orgNameOf(preview) }
      : null;

  return (
    <div className="pws-root">
      <StudioTopBar
        name={detail.name}
        versionTag={publishedNumber !== null ? `v${publishedNumber}` : 'Not published'}
        canManage={canManage}
        saveState={saveState}
        saveLabel={saveLabel}
        mode={mode}
        onMode={switchMode}
        readiness={readiness}
        wide={wide}
        onOpenChecks={openChecks}
        onCompare={() => openCompare()}
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
        identity={identity}
        onSwitchAccount={() => void leave(() => redirectToLogin({ selectAccount: true }))}
        onSignOut={() => void leave(() => void logout())}
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
        <div className="pws-bar pws-bar--ro">
          <b>View only.</b> You&apos;re seeing the published version. Editing and draft preview need the <b>Manage templates</b> permission.
        </div>
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
                Published {formatDate(viewVersion.activated_at ?? viewVersion.created_at)} · read only
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
              <div className="pws-doc__scroll pws-doc__scroll--version">
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
                loading={canManage && pvLoading}
                error={canManage ? pvError : null}
                emptyLabel={canManage ? 'Add content to the draft, then preview it.' : 'This template has no published version yet.'}
                templateId={detail.id}
                map={map}
                highlight={highlight}
                onHighlight={setHighlight}
                zoom={zoom}
                onZoom={setZoom}
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
            canManage={canManage}
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
      />
      <WithdrawDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} name={detail.name} busy={actionBusy} error={actionError} onWithdraw={doWithdraw} />
      <CancelWithdrawalDialog open={cancelWdOpen} onOpenChange={setCancelWdOpen} busy={actionBusy} error={actionError} onConfirm={doCancelWithdrawal} />
      {viewVersion !== null ? (
        <RestoreDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          version={viewVersion.version_number}
          onConfirm={() => {
            const src = contentDoc(viewVersion);
            setRestoreOpen(false);
            if (src === null) return;
            change(() => ({ title: src.title, blocks: cloneBlocks(src.blocks) }));
            setViewVersionId(null);
            setMode('edit');
            toast(`Draft replaced with v${viewVersion.version_number}. Save and preview before publishing.`);
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
