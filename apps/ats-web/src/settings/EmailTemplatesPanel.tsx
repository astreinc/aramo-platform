import { useCallback, useEffect, useState } from 'react';
import { hasScope, Input, TextArea, useSession, useToast, type Session } from '@aramo/fe-foundation';

import { Button, Card, ErrorState, LoadingState, safeErrorMessage } from '../ui';
import {
  createEmailTemplate,
  deactivateEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  updateEmailTemplate,
  MERGE_FIELD_REFERENCE,
  type EmailTemplatePreview,
  type EmailTemplateView,
} from '../communications/email-templates-api';

import { SettingsSection, SettingCardHead, StatChip, SettingHint } from './components';

// D-EMAIL-TPL-1 (ET-6) — Settings → Communication → Email & notifications template
// management. This is a THIN surface over the ET-4 APIs; the server owns rendering,
// merge-token validation, and the system-default-vs-override decision. RBAC mirrors
// the server: communication:template:read → view/preview; :manage → mutation. D-1:
// the system default is read-only — "Edit" on it CREATES a tenant override; it never
// mutates the default. Provider/mailbox setup stays under Integrations (not here).

const READ_SCOPE = 'communication:template:read';
const MANAGE_SCOPE = 'communication:template:manage';

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  requisition_initial_contact: 'Requisition Talent Contact',
  // COMM-RECRUITER-W1 (W1-A1) — Talent-only, no requisition.
  talent_general_contact: 'General Talent Contact',
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

interface Props {
  readonly sessionOverride?: Session;
  readonly listFn?: typeof listEmailTemplates;
  readonly createFn?: typeof createEmailTemplate;
  readonly updateFn?: typeof updateEmailTemplate;
  readonly deactivateFn?: typeof deactivateEmailTemplate;
  readonly previewFn?: typeof previewEmailTemplate;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly EmailTemplateView[] }
  | { status: 'error'; message: string };

interface EditorState {
  readonly base: EmailTemplateView;
  readonly isNew: boolean; // true = creating an override from the system default
  name: string;
  subject: string;
  body: string;
}

export function EmailTemplatesPanel({
  sessionOverride,
  listFn = listEmailTemplates,
  createFn = createEmailTemplate,
  updateFn = updateEmailTemplate,
  deactivateFn = deactivateEmailTemplate,
  previewFn = previewEmailTemplate,
}: Props = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead = session != null && hasScope(session, READ_SCOPE);
  const canManage = session != null && hasScope(session, MANAGE_SCOPE);
  const toast = useToast();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ readonly id: string; readonly result: EmailTemplatePreview } | null>(
    null,
  );

  const refetch = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const items = await listFn();
      setLoad({ status: 'ready', items });
    } catch (err) {
      setLoad({ status: 'error', message: safeErrorMessage(err, 'Failed to load email templates.') });
    }
  }, [listFn]);

  useEffect(() => {
    if (!canRead) return;
    void refetch();
  }, [canRead, refetch]);

  const description = (
    <>
      Reusable email templates recruiters send from. Aramo already delivers email — provider and
      mailbox setup live under Settings → Integrations → Communications; this page manages the
      template content only.
    </>
  );

  if (!canRead) {
    return (
      <SettingsSection title="Email & notifications" description={description}>
        <Card>
          <SettingHint>
            You don’t have permission to view email templates. Ask a workspace admin for the
            email-template permission.
          </SettingHint>
        </Card>
      </SettingsSection>
    );
  }

  function openCreateOverride(base: EmailTemplateView) {
    setPreview(null);
    setEditor({ base, isNew: true, name: base.name, subject: base.subject_template, body: base.body_template });
  }

  function openEdit(base: EmailTemplateView) {
    setPreview(null);
    setEditor({ base, isNew: false, name: base.name, subject: base.subject_template, body: base.body_template });
  }

  function closeEditor() {
    setEditor(null);
    setPreview(null);
  }

  async function saveEditor() {
    if (editor == null) return;
    setBusy(true);
    try {
      if (editor.isNew) {
        await createFn({
          category: editor.base.category,
          name: editor.name,
          subject_template: editor.subject,
          body_template: editor.body,
        });
        toast.show('Template override created.');
      } else {
        const id = editor.base.id;
        if (id == null) throw new Error('cannot update a system default');
        await updateFn(id, {
          name: editor.name,
          subject_template: editor.subject,
          body_template: editor.body,
        });
        toast.show('Template override saved.');
      }
      closeEditor();
      await refetch();
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefault(target: EmailTemplateView) {
    if (target.id == null) return;
    setBusy(true);
    try {
      await deactivateFn(target.id);
      toast.show('Reset to the system default.');
      closeEditor();
      await refetch();
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(id: string, subject_template: string, body_template: string) {
    setBusy(true);
    try {
      const result = await previewFn(id, { subject_template, body_template });
      setPreview({ id, result });
    } catch (err) {
      toast.show(safeErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Email & notifications" description={description}>
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={() => void refetch()} /> : null}

      {load.status === 'ready'
        ? load.items.map((t) => {
            const rowKey = t.id ?? `default:${t.template_key}`;
            const editing = editor != null && editor.base.template_key === t.template_key;
            const previewForRow = preview != null && preview.id === (t.id ?? 'draft');
            return (
              <Card key={rowKey}>
                <SettingCardHead
                  title={t.name}
                  sub={categoryLabel(t.category)}
                />
                <div className="set-row">
                  <div className="set-row__l">
                    {t.is_system_default ? (
                      <StatChip tone="muted" dot>
                        System default (read-only)
                      </StatChip>
                    ) : (
                      <StatChip tone="brand" dot>
                        Tenant override
                      </StatChip>
                    )}
                  </div>
                  <div className="set-row__r">
                    {!editing ? (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void runPreview(t.id ?? 'draft', t.subject_template, t.body_template)
                          }
                          disabled={busy}
                        >
                          Preview
                        </Button>
                        {canManage && t.is_system_default ? (
                          <Button onClick={() => openCreateOverride(t)} disabled={busy}>
                            Create override
                          </Button>
                        ) : null}
                        {canManage && !t.is_system_default ? (
                          <>
                            <Button onClick={() => openEdit(t)} disabled={busy}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => void resetToDefault(t)}
                              disabled={busy}
                            >
                              Reset to default
                            </Button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>

                {!editing ? (
                  <div className="set-tpl__view">
                    <p className="set-tpl__subject">
                      <strong>Subject:</strong> {t.subject_template}
                    </p>
                    <pre className="set-tpl__body">{t.body_template}</pre>
                  </div>
                ) : null}

                {editing && editor != null ? (
                  <div className="set-tpl__editor">
                    <label>
                      Template name
                      <Input
                        type="text"
                        aria-label="Template name"
                        value={editor.name}
                        onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                      />
                    </label>
                    <label>
                      Subject
                      <Input
                        type="text"
                        aria-label="Subject"
                        value={editor.subject}
                        onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                      />
                    </label>
                    <label>
                      Body
                      <TextArea
                        aria-label="Body"
                        rows={8}
                        value={editor.body}
                        onChange={(e) => setEditor({ ...editor, body: e.target.value })}
                      />
                    </label>
                    <div className="set-tpl__editor-actions">
                      <Button onClick={() => void saveEditor()} disabled={busy}>
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void runPreview(editor.base.id ?? 'draft', editor.subject, editor.body)
                        }
                        disabled={busy}
                      >
                        Preview
                      </Button>
                      <Button variant="ghost" onClick={closeEditor} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}

                {previewForRow && preview != null ? (
                  <div className="set-tpl__preview" aria-label="Rendered preview">
                    <p className="set-tpl__subject">
                      <strong>Preview subject:</strong> {preview.result.subject}
                    </p>
                    <pre className="set-tpl__body">{preview.result.body}</pre>
                    {preview.result.warnings.length > 0 ? (
                      <SettingHint>
                        Some sample fields were unavailable: {preview.result.warnings.join(', ')}
                      </SettingHint>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            );
          })
        : null}

      {load.status === 'ready' ? (
        <Card>
          <SettingCardHead title="Merge fields" sub="Server-resolved from the requisition and talent" />
          <ul className="set-tpl__fields">
            {MERGE_FIELD_REFERENCE.map((f) => (
              <li key={f.token}>
                <code>{f.token}</code> — {f.label}
              </li>
            ))}
          </ul>
          <SettingHint>
            Only these merge fields are allowed; every value is resolved on the server. Unknown fields
            are rejected when you save.
          </SettingHint>
        </Card>
      ) : null}
    </SettingsSection>
  );
}
