import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// CCP-R3-W item 5 ("no bypass") — a source scan + route enumeration proving that every serializer
// of the W-2 / W-3 / item-3 fields goes through the shared projection in
// libs/subscription/src/lib/billing/finance-amount-withholding.ts. A NEW serializer of any of these
// fields, a NEW commercial route, a new audit-payload reader, a notification sender, or a log line
// carrying requester text fails this spec until it is classified here (and routed through the helper).

const APP = resolve(__dirname, '../app/platform');
const LIB = resolve(__dirname, '../../../../libs/subscription/src/lib');
const read = (p: string): string => readFileSync(p, 'utf8');
/** Comments removed (line and block), strings kept: the scan looks at code only. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(resolve(dir, d.name)) : d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts') ? [resolve(dir, d.name)] : []));

const appFiles = readdirSync(APP).filter((f) => f.endsWith('.ts'));

// The sensitive READS a serializer would make (receiver.field), excluding request-body inputs.
const FIELD = /\b([A-Za-z_][\w.]*)\.(terms|recorded_terms|reason|rejection_reason|comment|last_error_detail|category|payload|evidence|basis)\b/g;
const INPUT_RECEIVERS = ['body', 'err', 'e', 'input'];

function hits(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of appFiles) {
    for (const m of code(read(resolve(APP, f))).matchAll(FIELD)) {
      const receiver = m[1] as string;
      if (INPUT_RECEIVERS.includes(receiver)) continue;
      const k = `${f} ${receiver}.${m[2]}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

// Every serializer read of a sensitive field in apps/platform-admin/src/app/platform, with the helper
// its file must use (null = not a W-2 / W-3 / item-3 field: catalog plan terms, reason codes, the
// Personal and domain-claim operator reasons, the alert evidence object).
const EXPECTED: Record<string, { count: number; helper: string | null; why: string }> = {
  'platform-commercial-contract.controller.ts c.terms': { count: 1, helper: 'withholdContractTerms', why: 'W-2 contract detail' },
  'platform-commercial-contract.controller.ts c.recorded_terms': { count: 1, helper: 'withholdContractTerms', why: 'W-2 contract detail' },
  'platform-commercial-contract.controller.ts a.terms': { count: 1, helper: 'withholdContractTerms', why: 'W-2 amendment' },
  'platform-commercial-change-request.controller.ts f.payload': { count: 1, helper: 'projectChangeRequestFinance', why: 'R3 + W-2 + W-3 projection output' },
  'platform-commercial-change-request.controller.ts f.basis': { count: 1, helper: 'projectChangeRequestFinance', why: 'R3 chain basis' },
  'platform-commercial-change-request.controller.ts f.reason': { count: 1, helper: 'projectChangeRequestFinance', why: 'W-3 reason' },
  'platform-commercial-change-request.controller.ts f.rejection_reason': { count: 1, helper: 'projectChangeRequestFinance', why: 'W-3 notes' },
  'platform-commercial-change-request.controller.ts a.comment': { count: 1, helper: 'projectApprovalNotes', why: 'W-3 approver comment' },
  'platform-commercial-change-request.controller.ts apply.reason': { count: 1, helper: null, why: 'A9 role-change apply refusal code (not financial)' },
  'platform-commercial-billing.controller.ts row.last_error_detail': { count: 2, helper: 'isFinancialCommandKind', why: 'item 3 C4 command provider text' },
  'platform-commercial-audit.controller.ts row.payload': { count: 1, helper: 'withholdAuditPayloadAmounts', why: 'A2 audit body (R3 + W-2 + W-3 + item 3)' },
  'platform-commercial-refund-report.controller.ts r.category': { count: 1, helper: 'evidenceVisible', why: 'W-3 REFUND evidence' },
  'platform-commercial-catalog.controller.ts v.terms': { count: 1, helper: null, why: 'plan-version catalog terms (W-1/FA-3: catalog information, not contract terms)' },
  'platform-commercial-revenue.controller.ts r.basis': { count: 1, helper: null, why: 'D2 revenue basis label (a constant), amount-scope route' },
  'platform-commercial-subscriptions.controller.ts f.reason': { count: 1, helper: null, why: 'B3 reconciliation flag reason code' },
  'platform-commercial-billing-status.controller.ts s.tax.reason': { count: 1, helper: null, why: 'C5 tax availability code' },
  'platform-commercial-observability.controller.ts row.evidence': { count: 1, helper: null, why: 'D3 alert evidence (scanned below: carries none of the W fields)' },
  'platform-personal.controller.ts v.reason': { count: 1, helper: null, why: 'Personal (Sign) risk review reason — not CCP' },
  'platform-personal.controller.ts r.reason': { count: 1, helper: null, why: 'Personal (Sign) report reason — not CCP' },
  'platform.controller.ts v.claim.reason': { count: 1, helper: null, why: 'domain-claim reason — not CCP' },
};

describe('CCP-R3-W — no bypass: source scan and route enumeration', () => {
  it('R3W-SCAN-1 every sensitive-field read in the platform-admin platform sources is exactly the classified set (exact counts); each W-2 / W-3 / item-3 one is in a file that uses its helper', () => {
    const found = Object.fromEntries([...hits()].sort());
    expect(found).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.count]).sort()));
    for (const [k, v] of Object.entries(EXPECTED)) {
      if (v.helper === null) continue;
      const file = k.split(' ')[0] as string;
      expect(code(read(resolve(APP, file))), `${k} → ${v.helper}`).toContain(`${v.helper}(`);
    }
    expect(Object.values(EXPECTED).filter((v) => v.helper !== null).length).toBe(11);
  });

  it('R3W-SCAN-2 every change-request serialization takes the FinanceReader (requester + amount decision); approvalDto always takes the action type and the reader; no caller passes a bare amount boolean', () => {
    let requestDtoCalls = 0;
    let approvalCalls = 0;
    // the argument list of each call, with balanced parentheses
    const calls = (src: string, name: string): string[] => {
      const out: string[] = [];
      const re = new RegExp(`\\b${name}\\(`, 'g');
      for (const m of src.matchAll(re)) {
        let depth = 1;
        let i = (m.index as number) + m[0].length;
        const start = i;
        while (i < src.length && depth > 0) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') depth -= 1;
          i += 1;
        }
        out.push(src.slice(start, i - 1));
      }
      return out;
    };
    for (const f of appFiles) {
      const src = code(read(resolve(APP, f)));
      for (const name of ['requestDto', 'adjustmentRequestDto']) {
        for (const args of calls(src, name)) {
          if (/^\s*r: CommercialChangeRequestRow/.test(args)) continue; // the definitions
          requestDtoCalls += 1;
          expect(args, `${f}: ${name}(${args})`).toMatch(/,\s*(financeReader\(auth\)|reader)\s*$/);
        }
      }
      for (const args of calls(src, 'approvalDto')) {
        if (/^\s*a: CommercialApprovalRow/.test(args)) continue;
        approvalCalls += 1;
        expect(args, `${f}: approvalDto(${args})`).toMatch(/action_type,\s*(financeReader\(auth\)|reader)\s*$/);
      }
    }
    expect(requestDtoCalls).toBe(15);
    expect(approvalCalls).toBe(2);
  });

  // Every handler under /platform/commercial, by controller, with what it serializes.
  const ROUTES: Record<string, { handlers: string[]; serializes: string }> = {
    'platform-commercial-change-request.controller.ts': { handlers: ['create', 'list', 'get', 'submit', 'withdraw', 'approve', 'reject'], serializes: 'change requests + approvals (requestDto / approvalDto); REFUND_NOT_REFUNDABLE detail (toAramoError amount_access)' },
    'platform-commercial-apply.controller.ts': { handlers: ['applyRequest'], serializes: 'change request (requestDto); applyHttpError amount_access' },
    'platform-commercial-billing-adjustment.controller.ts': { handlers: ['applyAdjustment', 'resolveRefund', 'read'], serializes: 'change request (requestDto), C4 commands (billingCommandDto), refusal details (withholdErrorProviderText)' },
    'platform-commercial-conversion.controller.ts': { handlers: ['convert', 'read'], serializes: 'change request (requestDto)' },
    'platform-commercial-support-extension.controller.ts': { handlers: ['request', 'list'], serializes: 'change request (requestDto)' },
    'platform-commercial-contract.controller.ts': { handlers: ['list', 'get'], serializes: 'contract summary (no terms) / detail (withholdContractTerms)' },
    'platform-commercial-audit.controller.ts': { handlers: ['list'], serializes: 'audit bodies (withholdAuditPayloadAmounts)' },
    'platform-commercial-governance.controller.ts': { handlers: ['listPolicyVersions', 'createPolicyDraft', 'updatePolicyDraft', 'exportAudit', 'listOperators'], serializes: 'policy (no financial text); B5 CSV export built in the lib by buildAuditCsv (withholdAuditPayloadAmounts)' },
    'platform-commercial-billing.controller.ts': { handlers: ['listCommands', 'listInbox'], serializes: 'commands (billingCommandDto: item 3); webhook inbox (no W field)' },
    'platform-commercial-refund-report.controller.ts': { handlers: ['list'], serializes: 'refund rows (evidenceVisible)' },
    'platform-commercial-billing-status.controller.ts': { handlers: ['tenantBillingStatus', 'portalConfiguration'], serializes: 'C3 (R3 amounts; no W field)' },
    'platform-commercial-finance.controller.ts': { handlers: ['renewals', 'outstanding', 'reconciliation'], serializes: 'C6 (R3 amounts; catalog list prices W-1; no W field)' },
    'platform-commercial-revenue.controller.ts': { handlers: ['report'], serializes: 'D2 (R3 amounts; no W field)' },
    'platform-commercial-observability.controller.ts': { handlers: ['listBillingAlerts', 'listApprovalAlerts', 'billingMetrics', 'approvalMetrics'], serializes: 'D3 alerts / metrics (no W field; evidence scanned in R3W-SCAN-5)' },
    'platform-commercial-subscriptions.controller.ts': { handlers: ['list', 'tenant'], serializes: 'B3 (no money, no terms, no reason)' },
    'platform-commercial-catalog.controller.ts': { handlers: ['read', 'readVersion', 'createDraft', 'updateDraft'], serializes: 'catalog (W-1 list prices; plan terms are catalog information)' },
    'platform-commercial-usage.controller.ts': { handlers: ['reconciliation', 'periods'], serializes: 'D1 usage (no W field)' },
    // Merge train TD-MERGE-50 (C8-PR): the contract payments read. Payment terms, amounts and the receipt
    // records (evidence included) go only to a Finance amount holder (contractPaymentsDto amount_access);
    // every other billing reader gets obligation statuses and the FA-4 booleans.
    'platform-commercial-contract-payments.controller.ts': { handlers: ['contractPayments'], serializes: 'C8-PR obligations / receipts (contractPaymentsDto amount_access: terms, amounts and evidence holder-only)' },
  };

  it('R3W-SCAN-3 route enumeration: every commercial controller is classified, and the handler set of each classified controller is exactly the listed one', () => {
    const controllers = appFiles.filter((f) => /^platform-commercial-.*\.controller\.ts$/.test(f)).sort();
    expect(controllers).toEqual(Object.keys(ROUTES).sort());
    expect(controllers.length).toBe(18);
    let total = 0;
    for (const f of controllers) {
      const src = code(read(resolve(APP, f)));
      const handlers = [...src.matchAll(/@(?:Get|Post|Patch|Put|Delete)\([^)]*\)[\s\S]*?async\s+(\w+)\s*\(/g)].map((m) => m[1] as string);
      total += handlers.length;
      expect(handlers.sort(), f).toEqual([...ROUTES[f]!.handlers].sort());
    }
    expect(total).toBe(Object.values(ROUTES).reduce((n, r) => n + r.handlers.length, 0));
    expect(total).toBe(45); // 44 + C8-PR contractPayments (TD-MERGE-50)
  });

  it('R3W-SCAN-4 lib side: the audit stream is read out only by the A2 repository (feed + export, both through withholdAuditPayloadAmounts); the other readers select no requester text', () => {
    const readers = walk(LIB)
      .filter((f) => /commercialAuditEvent\.(findMany|findFirst|findUnique)/.test(code(read(f))))
      .map((f) => f.slice(LIB.length + 1))
      .sort();
    expect(readers).toEqual(['commercial/commercial-audit.repository.ts', 'commercial/commercial-change-request.service.ts', 'commercial/commercial-refund-report.service.ts', 'commercial/support-extension.service.ts']);
    expect(code(read(resolve(LIB, 'commercial/commercial-audit-export.service.ts')))).toMatch(/withholdAuditPayloadAmounts\(\(r\.payload \?\? \{\}\) as Record<string, unknown>, names\.amount_access === true\)/);
    expect(code(read(resolve(LIB, 'commercial/commercial-audit-export.service.ts')))).toContain('financeAmountAccess(actor.scopes)');
    // refund report: change_request_id only; support extension: clause / counters only (recordOfInts).
    expect(code(read(resolve(LIB, 'commercial/commercial-refund-report.service.ts')))).toMatch(/commercialAuditEvent\.findMany\(.*select: \{ change_request_id: true \} \}\)/);
    expect(code(read(resolve(LIB, 'commercial/support-extension.service.ts')))).toContain("clause: recordOfInts(basis?.['clause'])");
  });

  it('R3W-SCAN-5 D3 alert payloads carry no request reason, note, evidence, contract term or C4 provider text (every evidence object, by key)', () => {
    const src = code(read(resolve(LIB, 'observability/commercial-alert.service.ts')));
    const evidence = [...src.matchAll(/evidence: \{([^}]*)\}/g)].map((m) => m[1] as string);
    // 10: CCP-C8-PR adds PAYMENT_RECEIPT_UNLINKED (receipt id, refs and recorded_at; no amount, no evidence).
    expect(evidence.length).toBe(10);
    for (const e of evidence) {
      const keys = [...e.matchAll(/(\w+):/g)].map((m) => m[1] as string);
      for (const k of ['terms', 'recorded_terms', 'comment', 'rejection_reason', 'category', 'basis', 'error', 'last_error_detail', 'message', 'amount_minor']) expect(keys, e).not.toContain(k);
      // the only `reason` key is the reconciliation flag code constant
      if (keys.includes('reason')) expect(e).toContain('reason: GOVERNED_SUBSCRIPTION_OPEN');
    }
    expect(src).not.toMatch(/req\.reason|request\.reason|\.rejection_reason|\.comment\b|\.terms\b|last_error_detail/);
  });

  it('R3W-SCAN-6 notifications: no commercial source sends one (0 imports of the mailer, communications or outbox publisher in the subscription lib and the platform controllers)', () => {
    const senders = [...walk(LIB), ...appFiles.map((f) => resolve(APP, f))].filter((f) => /from '@aramo\/(mailer|communications|outbox-publisher)'/.test(read(f)));
    expect(senders).toEqual([]);
  });

  it('R3W-SCAN-7 logs: no commercial log line interpolates requester text, notes or contract terms', () => {
    const files = [...walk(resolve(LIB, 'commercial')), ...walk(resolve(LIB, 'billing')), ...walk(resolve(LIB, 'observability')), ...appFiles.filter((f) => f.startsWith('platform-commercial-') || f === 'commercial-alert-scanner.service.ts').map((f) => resolve(APP, f))];
    for (const f of files) {
      for (const m of code(read(f)).matchAll(/\b(?:log|logger)\.(?:warn|error|log|debug|verbose)\(([^;]*)\);/g)) {
        expect(m[1] as string, f).not.toMatch(/\.(reason|rejection_reason|comment|terms|recorded_terms|category)\b|\.basis\b/);
      }
    }
  });

  it('R3W-SCAN-8 W-1: no response DTO names a negotiated, contracted or effective tenant price', () => {
    const dtos = readdirSync(resolve(APP, 'dto')).map((f) => code(read(resolve(APP, 'dto', f)))).join('\n');
    expect(dtos).not.toMatch(/\b(negotiated|contracted|effective)_(price|rate|amount)\w*\??:/);
    expect(dtos).not.toMatch(/\b(contract|tenant)_price(_minor|_amount)?\??:/);
  });
});
