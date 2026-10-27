import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  FormField,
  InlineAlert,
  Input,
  Select,
  SettingsSection,
  safeErrorMessage,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import {
  canAuthorTemplates,
  createOwnTemplate,
  fetchTemplateLibrary,
  useDocTemplateRoutes,
  type TemplateDocumentType,
} from '@aramo/document-templates-web';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2; ADR-0034 D5) — "Create your own document template".
// A new template owned by this organization, for a document type that can be configured,
// starting from a BLANK draft. There is deliberately no "start from an Aramo default"
// option: the organization's own template is its own work (no copy, no link, no
// "new Aramo version" prompts). The draft opens in the Template Studio; approving it (after a
// preview) makes it the template in use for its document type.
// ORG-UX-1 §4.1 — creating is authoring (document_template:author or :manage); approving
// stays manage-only.

const NAME_MAX = 120;

export function CreateOwnTemplate({
  sessionOverride,
  libraryFn = fetchTemplateLibrary,
  createFn = createOwnTemplate,
}: {
  readonly sessionOverride?: Session;
  readonly libraryFn?: typeof fetchTemplateLibrary;
  readonly createFn?: typeof createOwnTemplate;
}) {
  const sessionState = useSession();
  const session = sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canAuthor = canAuthorTemplates(session);
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const [types, setTypes] = useState<readonly TemplateDocumentType[] | null>(null);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canAuthor) return;
    libraryFn().then(
      (lib) => {
        const configurable = lib.document_types.filter((t) => t.configurable);
        setTypes(configurable);
        setTypeId((cur) => (cur === '' ? (configurable[0]?.id ?? '') : cur));
      },
      (err: unknown) => setError(safeErrorMessage(err, 'Could not load the document types.')),
    );
  }, [canAuthor, libraryFn]);

  if (!canAuthor) {
    return (
      <SettingsSection title="Create your own document template">
        <p className="org-muted" data-testid="dt-create-noaccess">
          You don’t have permission to create document templates.
        </p>
      </SettingsSection>
    );
  }

  const trimmed = name.trim();
  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (saving || trimmed.length === 0 || typeId === '') return;
    setSaving(true);
    setError('');
    try {
      const { template } = await createFn({ document_type_id: typeId, name: trimmed });
      navigate(routes.detail(template.id));
    } catch (err) {
      setError(safeErrorMessage(err, 'Could not create the template.'));
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Create your own document template"
      description="Write your organization’s own wording from a blank document. Nothing is used until it’s approved."
    >
      <form className="org-dt-form" onSubmit={(e) => void onSubmit(e)} data-testid="dt-create-form">
        {error !== '' ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        <FormField label="Document type">
          <Select unstyled className="rc-input" value={typeId} onChange={(e) => setTypeId(e.target.value)} data-testid="dt-create-type">
            {(types ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Template name">
          <Input
            unstyled
            className="rc-input"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="Our Right to Represent"
            data-testid="dt-create-name"
          />
        </FormField>
        <p className="org-muted">The template starts blank. Insert fields from the Aramo field list in the Template Studio.</p>
        <div className="org-dt-form__actions">
          <Button unstyled className="dt-btn dt-btn--outline" type="button" onClick={() => navigate(routes.list)}>Cancel</Button>
          <Button type="submit" disabled={saving || trimmed.length === 0 || typeId === ''} data-testid="dt-create-submit">
            Create and open the Studio
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
