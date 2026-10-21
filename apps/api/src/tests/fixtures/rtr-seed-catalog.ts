import type { TemplateVariableCatalogReader, TemplateVariableRow } from '@aramo/documents';

import { RTR_BINDING_CATALOG } from '../../rtr/rtr-template-content.js';

// DOC-TEMPLATE-LIB-1 T-2 — an in-memory TemplateVariable catalog for unit tests: the 8
// RTR rows exactly as migration 20261021120000 seeds them (key = ats_binding_key, ATS
// product, the safe sample). The real-DB parity is proven by the gated integration spec.
export function seededRtrCatalogRows(): TemplateVariableRow[] {
  const at = new Date('2026-10-21T12:00:00.000Z');
  return RTR_BINDING_CATALOG.map((d, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    key: d.key,
    label: d.label,
    group_label: d.group,
    data_type: d.key === 'requisition.description' ? 'MULTILINE_TEXT' : 'TEXT',
    products: ['ATS'],
    ats_binding_key: d.key,
    sample_value: d.sample,
    active: true,
    created_at: at,
    updated_at: at,
  }));
}

// A reader over the given rows, honouring `active` like the repository does. The rows
// are listed in reverse to prove the capability orders by resolver order, not row order.
export function fakeCatalog(rows: TemplateVariableRow[] = seededRtrCatalogRows()): TemplateVariableCatalogReader {
  return {
    async listActive() {
      return [...rows].reverse().filter((r) => r.active);
    },
  };
}
