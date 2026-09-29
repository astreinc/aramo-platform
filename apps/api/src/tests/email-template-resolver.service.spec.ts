import { describe, it, expect } from 'vitest';
import type { EmailTemplateRepository, EmailTemplateRow } from '@aramo/communications';

import { EmailTemplateResolverService } from '../communications/email-template-resolver.service.js';

// D-EMAIL-TPL-1 (ET-2) — the D-1 Option C source DECISION in isolation (no DB).
// The tenant-scoping proof itself is the real-Postgres integration spec in
// libs/communications; here we prove only the override-vs-default branch.

const KEY = 'requisition-contact';

function resolver(row: EmailTemplateRow | null): EmailTemplateResolverService {
  const repo = { findActiveByKey: async () => row } as unknown as EmailTemplateRepository;
  return new EmailTemplateResolverService(repo);
}

const ROW: EmailTemplateRow = {
  id: 'row-1',
  tenant_id: 't1',
  template_key: KEY,
  category: 'requisition_initial_contact',
  name: 'Tenant template',
  subject_template: 'Re: {{requisition.title}}',
  body_template: 'Hi {{talent.first_name}}',
  is_active: true,
  created_at: new Date(0),
  updated_at: new Date(0),
};

describe('EmailTemplateResolverService (ET-2)', () => {
  it('tenant override present → source=tenant_override, carries the row id + templates (D-5 provenance)', async () => {
    const r = await resolver(ROW).resolveSource('t1', KEY);
    expect(r.source).toBe('tenant_override');
    if (r.source === 'tenant_override') {
      expect(r.template_id).toBe('row-1');
      expect(r.subject_template).toBe('Re: {{requisition.title}}');
      expect(r.body_template).toBe('Hi {{talent.first_name}}');
    }
  });

  it('no override → source=system_default (the code-owned default applies)', async () => {
    const r = await resolver(null).resolveSource('t2', KEY);
    expect(r.source).toBe('system_default');
    expect(r.template_key).toBe(KEY);
  });
});
