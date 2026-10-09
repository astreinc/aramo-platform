import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { hasScope, IconFile, Input, TextArea, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, EmptyState, ErrorState, LoadingState, safeErrorMessage } from '../../ui';
import { SettingsSection, SettingCardHead, StatChip, SettingHint } from '../components';

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
  type TemplateSamplePreview,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§11/§17-§21) — the Right-to-Represent DRAFT editor. The
// admin edits the title + content blocks (HEADING/TEXT), inserts governed fields from
// the server's Insert-field catalog (§15 — the ONLY tokens allowed; no raw DB paths),
// then PREVIEWS the fixed-sample output (§17) before APPROVING & activating (§18-§21).
// The §18 preview gate is server-authoritative: editing re-arms it (a prior preview is
// invalidated), so the flow is Save → Preview → Approve. Unsupported bindings fail
// closed at activation (§14/§19, 422). Historical versions are immutable (§34): editing
// always targets the single open DRAFT.

const DETAIL_ROUTE = '/admin/settings/document-templates/rtr';

interface Block {
  type: 'HEADING' | 'TEXT';
  text: string;
}

// Safe parse of a stored RTR field_schema into {title, blocks}. Tolerant: an empty or
// not-yet-authored draft starts blank.
function parseContent(field_schema: unknown): { title: string; blocks: Block[] } {
  if (field_schema == null || typeof field_schema !== 'object') return { title: '', blocks: [] };
  const obj = field_schema as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks: Block[] = rawBlocks
    .map((b) => {
      const bb = b as Record<string, unknown>;
      const type = bb.type === 'HEADING' ? 'HEADING' : 'TEXT';
      return { type, text: typeof bb.text === 'string' ? bb.text : '' } as Block;
    });
  return { title, blocks };
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; templateId: string; version: TemplateVersionView; bindings: readonly TemplateBinding[] }
  | { status: 'nodraft' }
  | { status: 'error'; message: string };

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
  const [versionId, setVersionId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // §18 gate mirror (backend authoritative): any edit marks the content dirty and
  // clears the preview; Preview requires a save first; Approve requires a clean preview.
  const [dirty, setDirty] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [preview, setPreview] = useState<TemplateSamplePreview | null>(null);
  const [activated, setActivated] = useState(false);

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const templates = await listTemplatesFn();
      const rtr = templates.find((t) => t.document_type_id === RIGHT_TO_REPRESENT_TYPE_ID) ?? null;
      if (rtr == null) {
        setLoad({ status: 'nodraft' });
        return;
      }
      const [versions, bindings] = await Promise.all([listVersionsFn(rtr.id), listBindingsFn(rtr.id)]);
      const draft = versions.find((v) => v.status === 'DRAFT');
      if (draft == null) {
        setLoad({ status: 'nodraft' });
        return;
      }
      const parsed = parseContent(draft.field_schema);
      setVersionId(draft.id);
      setTitle(parsed.title);
      setBlocks(parsed.blocks);
      // A freshly-loaded draft reflects its persisted state: clean, and previewed iff
      // the server already recorded a preview for the current content.
      setDirty(false);
      setPreviewed(draft.previewed_fingerprint != null && draft.previewed_fingerprint === draft.content_fingerprint);
      setPreview(null);
      setLoad({ status: 'ready', templateId: rtr.id, version: draft, bindings });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load the draft.') });
    }
  }, [listTemplatesFn, listVersionsFn, listBindingsFn]);

  useEffect(() => {
    if (!canManage) return;
    void refetch();
  }, [canManage, refetch]);

  function markEdited(next: { title?: string; blocks?: Block[] }) {
    if (next.title !== undefined) setTitle(next.title);
    if (next.blocks !== undefined) setBlocks(next.blocks);
    setDirty(true);
    setPreviewed(false);
    setPreview(null);
  }

  function addBlock(type: 'HEADING' | 'TEXT') {
    markEdited({ blocks: [...blocks, { type, text: '' }] });
  }
  function editBlock(i: number, text: string) {
    markEdited({ blocks: blocks.map((b, idx) => (idx === i ? { ...b, text } : b)) });
  }
  function removeBlock(i: number) {
    markEdited({ blocks: blocks.filter((_, idx) => idx !== i) });
  }
  function moveBlock(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    const [spliced] = next.splice(i, 1);
    next.splice(j, 0, spliced as Block);
    markEdited({ blocks: next });
  }
  // Insert a governed field token into the focused block (append at its end). The chip
  // set is the server catalog, so only allowed bindings can ever be inserted (§14/§15).
  function insertBinding(key: string) {
    const target = focused != null && focused < blocks.length ? focused : blocks.length - 1;
    if (target < 0) {
      // No block yet — start a TEXT block carrying the token.
      markEdited({ blocks: [{ type: 'TEXT', text: `{{${key}}}` }] });
      return;
    }
    markEdited({
      blocks: blocks.map((b, idx) => (idx === target ? { ...b, text: `${b.text}{{${key}}}` } : b)),
    });
  }

  async function save(): Promise<boolean> {
    if (versionId == null) return false;
    setBusy(true);
    try {
      await updateFn(versionId, {
        field_schema: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title, blocks },
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
      });
      setDirty(false);
      setPreviewed(false); // save re-arms the §18 gate — a new preview is required
      setPreview(null);
      toast.show('Draft saved.');
      return true;
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not save the draft. Please try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (versionId == null) return;
    // Preview reads the PERSISTED draft content; save pending edits first.
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await previewFn(versionId);
      setPreview(result);
      setPreviewed(true);
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Preview failed. Check that every field is a supported one.'));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (versionId == null) return;
    setBusy(true);
    try {
      await activateFn(versionId);
      setActivated(true);
      toast.show('Approved. This is now the version recruiters send.');
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Could not approve this version.'));
    } finally {
      setBusy(false);
    }
  }

  const backLink = (
    <Link to={DETAIL_ROUTE} className="set-navbtn" data-testid="rtr-editor-back">
      ← Back to Right to Represent
    </Link>
  );

  const description = (
    <>
      Edit the draft, insert only the supported fields, preview the result, then approve. Approving
      replaces the version recruiters send; the previous version is kept exactly as it was.
    </>
  );

  if (!canManage) {
    return (
      <SettingsSection title="Edit Right to Represent draft" description={description}>
        <Card>
          <SettingHint>You don’t have permission to edit document templates.</SettingHint>
        </Card>
      </SettingsSection>
    );
  }

  // §20 — success state after approval.
  if (activated) {
    return (
      <SettingsSection title="Edit Right to Represent draft" description={description} actions={backLink}>
        <Card>
          <SettingCardHead icon={<IconFile />} title="Approved" sub="This version is now live for recruiters" />
          <SettingHint>
            Recruiters now send this approved version. To make further changes, start a new draft.
          </SettingHint>
          <div className="set-row__r">
            <Button onClick={() => navigate(DETAIL_ROUTE)} data-testid="rtr-editor-done">
              Back to Right to Represent
            </Button>
          </div>
        </Card>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Edit Right to Represent draft" description={description} actions={backLink}>
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={() => void refetch()} /> : null}
      {load.status === 'nodraft' ? (
        <Card>
          <EmptyState message="There is no open draft to edit." />
          <SettingHint>Start a new draft from the Right to Represent page.</SettingHint>
        </Card>
      ) : null}

      {load.status === 'ready' ? (
        <>
          <Card>
            <SettingCardHead title={`Draft · v${load.version.version_number}`} sub="Title and content" />
            <label className="set-tpl__editor">
              Title
              <Input
                type="text"
                aria-label="Draft title"
                value={title}
                onChange={(e) => markEdited({ title: e.target.value })}
                data-testid="rtr-editor-title"
              />
            </label>

            {blocks.map((b, i) => (
              <div className="set-tpl__editor" key={i} data-testid={`rtr-block-${i}`}>
                <div className="set-row">
                  <div className="set-row__l">
                    <StatChip tone="muted">{b.type === 'HEADING' ? 'Heading' : 'Text'}</StatChip>
                  </div>
                  <div className="set-row__r">
                    <Button variant="ghost" onClick={() => moveBlock(i, -1)} disabled={i === 0} aria-label="Move up">
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => moveBlock(i, 1)}
                      disabled={i === blocks.length - 1}
                      aria-label="Move down"
                    >
                      ↓
                    </Button>
                    <Button variant="ghost" onClick={() => removeBlock(i)} aria-label="Remove block">
                      Remove
                    </Button>
                  </div>
                </div>
                <TextArea
                  aria-label={`Block ${i + 1}`}
                  rows={b.type === 'HEADING' ? 1 : 4}
                  value={b.text}
                  onFocus={() => setFocused(i)}
                  onChange={(e) => editBlock(i, e.target.value)}
                  data-testid={`rtr-block-text-${i}`}
                />
              </div>
            ))}

            <div className="set-row__r">
              <Button variant="ghost" onClick={() => addBlock('HEADING')} data-testid="rtr-add-heading">
                Add heading
              </Button>
              <Button variant="ghost" onClick={() => addBlock('TEXT')} data-testid="rtr-add-text">
                Add text
              </Button>
            </div>
          </Card>

          <Card>
            <SettingCardHead title="Insert a field" sub="Only these governed fields are allowed" />
            <div className="set-tpl__fields" data-testid="rtr-bindings">
              {load.bindings.map((bnd) => (
                <Button
                  key={bnd.key}
                  variant="ghost"
                  onClick={() => insertBinding(bnd.key)}
                  data-testid={`rtr-binding-${bnd.key}`}
                >
                  {bnd.label}
                </Button>
              ))}
            </div>
            <SettingHint>
              Every field is resolved by the server when a recruiter sends. Unknown fields are
              rejected when you approve.
            </SettingHint>
          </Card>

          <Card>
            <SettingCardHead title="Preview & approve" sub="Preview the sample output, then approve" />
            <div className="set-row__r">
              <Button onClick={() => void save()} disabled={busy || !dirty} data-testid="rtr-editor-save">
                Save draft
              </Button>
              <Button variant="ghost" onClick={() => void runPreview()} disabled={busy} data-testid="rtr-editor-preview">
                Preview
              </Button>
              <Button onClick={() => void approve()} disabled={busy || dirty || !previewed} data-testid="rtr-editor-approve">
                Approve &amp; activate
              </Button>
            </div>
            {!previewed ? (
              <SettingHint>Save and preview the current content before you can approve (§18).</SettingHint>
            ) : null}

            {preview != null ? (
              <div className="set-tpl__preview" aria-label="Sample preview" data-testid="rtr-editor-previewout">
                <p className="set-tpl__subject">
                  <strong>{preview.title}</strong>
                </p>
                {preview.blocks.map((blk, i) => (
                  <pre className="set-tpl__body" key={i}>
                    {blk.text}
                  </pre>
                ))}
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </SettingsSection>
  );
}
