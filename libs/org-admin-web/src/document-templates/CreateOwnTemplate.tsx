import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  FormField,
  InlineAlert,
  Input,
  Select,
  SettingsSection,
  hasScope,
  safeErrorMessage,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import {
  DOC_TEMPLATE_MANAGE_SCOPE,
  createOwnTemplate,
  fetchTemplateLibrary,
  useDocTemplateRoutes,
  type TemplateDocumentType,
} from '@aramo/document-templates-web';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2; ADR-0034 D5) — "Create your own document template".
// A new template owned by this organization, for a document type that can be configured,
// starting from a BLANK draft. There is deliberately no "start from an Aramo default"
// option: the organization's own template is its own work (no copy, no link, no
// "new Aramo version" prompts). The draft opens in the editor; approving it (after a
// preview) makes it the template in use for its document type.

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
  const canManage = session != null && hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  const navigate = useNavigate();
  const routes = useDocTemplateRoutes();
  const [types, setTypes] = useState<readonly TemplateDocumentType[] | null>(null);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    libraryFn().then(
      (lib) => {
        const configurable = lib.document_types.filter((t) => t.configurable);
        setTypes(configurable);
        setTypeId((cur) => (cur === '' ? (configurable[0]?.id ?? '') : cur));
      },
      (err: unknown) => setError(safeErrorMessage(err, 'Could not load the document types.')),
    );
  }, [canManage, libraryFn]);

  if (!canManage) {
    return (
      <SettingsSection title="Create your own document template">
        <p className="org-muted" data-testid="dt-create-noaccess">
          Only your organization’s owners and administrators can create document templates.
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
      navigate(routes.draft(template.id));
    } catch (err) {
      setError(safeErrorMessage(err, 'Could not create the template.'));
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Create your own document template"
      description="Write your organization’s own wording from a blank document. Aramo defaults stay available alongside it."
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
        <p className="org-muted">The template starts blank. Insert fields from the Aramo field list in the editor.</p>
        <div className="org-dt-form__actions">
          <Button unstyled className="dt-btn dt-btn--outline" type="button" onClick={() => navigate(routes.list)}>Cancel</Button>
          <Button type="submit" disabled={saving || trimmed.length === 0 || typeId === ''} data-testid="dt-create-submit">
            Create and open the editor
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
