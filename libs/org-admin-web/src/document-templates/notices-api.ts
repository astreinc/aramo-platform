import { apiClient } from '@aramo/fe-foundation';

// DOC-TEMPLATE-LIB-1 T-4 / T-6 (Implementation Directive v1.0 LOCKED §9; ADR-0034 D10) —
// the withdrawal notices the Org Home banner shows: Aramo defaults this organization uses
// (a selection names them, or it relies on the fallback to them) whose withdrawal has been
// announced (PENDING) or took effect recently (IN_EFFECT). GET /v1/document-templates/
// notices (document_template:read; T-6). A notice is information, never a gate: a failed
// read means no banner.
export const TEMPLATE_NOTICES_PATH = '/v1/document-templates/notices';

export interface TemplateWithdrawalNotice {
  readonly template_id: string;
  readonly name: string;
  readonly document_type_id: string;
  readonly products: readonly string[];
  readonly withdraw_notice_at: string;
  readonly withdraw_effective_at: string;
  readonly status: 'PENDING' | 'IN_EFFECT';
  readonly selected_for_client_ids: readonly string[];
  readonly relies_on_default: boolean;
  readonly has_own_template: boolean;
}

// Defensive read of `{ notices: [...] }`: entries missing their identity, name, status or
// effective date are dropped (the banner never renders a half-known notice).
export function parseNotices(raw: unknown): TemplateWithdrawalNotice[] {
  const list = (raw as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list)) return [];
  const out: TemplateWithdrawalNotice[] = [];
  for (const e of list) {
    if (e === null || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const status = o['status'];
    if (
      typeof o['template_id'] !== 'string' ||
      typeof o['name'] !== 'string' ||
      typeof o['withdraw_effective_at'] !== 'string' ||
      (status !== 'PENDING' && status !== 'IN_EFFECT')
    ) {
      continue;
    }
    out.push({
      template_id: o['template_id'],
      name: o['name'],
      document_type_id: typeof o['document_type_id'] === 'string' ? o['document_type_id'] : '',
      products: Array.isArray(o['products']) ? (o['products'] as unknown[]).filter((p): p is string => typeof p === 'string') : [],
      withdraw_notice_at: typeof o['withdraw_notice_at'] === 'string' ? o['withdraw_notice_at'] : '',
      withdraw_effective_at: o['withdraw_effective_at'],
      status,
      selected_for_client_ids: Array.isArray(o['selected_for_client_ids'])
        ? (o['selected_for_client_ids'] as unknown[]).filter((p): p is string => typeof p === 'string')
        : [],
      relies_on_default: o['relies_on_default'] === true,
      has_own_template: o['has_own_template'] === true,
    });
  }
  return out;
}

export async function fetchTemplateNotices(): Promise<TemplateWithdrawalNotice[]> {
  try {
    return parseNotices(await apiClient.get<unknown>(TEMPLATE_NOTICES_PATH));
  } catch {
    return [];
  }
}

// The banner sentence for one notice (manage holders also get the next step).
export function noticeMessage(n: TemplateWithdrawalNotice, fmt: (iso: string) => string, canManage: boolean): string {
  if (n.status === 'IN_EFFECT') {
    const next = n.has_own_template
      ? 'documents of this type now use your own approved template.'
      : 'choose a template for this document type before sending it again.';
    return `Aramo withdrew “${n.name}” on ${fmt(n.withdraw_effective_at)} — ${next}`;
  }
  const after = n.has_own_template
    ? 'After that, your own approved template for this document type is used.'
    : canManage
      ? 'Choose another template for this document type before then.'
      : 'Your administrators will choose another template before then.';
  return `Aramo is withdrawing “${n.name}”. From ${fmt(n.withdraw_effective_at)} it can no longer be used. ${after}`;
}
