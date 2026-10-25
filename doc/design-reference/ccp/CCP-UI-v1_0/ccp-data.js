// Prototype mock data + pure helpers for Commercial Control Plane.dc.html (no backend).
(function () {
const NOW = Date.UTC(2026, 9, 24, 14, 0), H = 36e5, D = 24 * H, ago = h => NOW - h * H;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ms = d => d == null ? null : typeof d === 'number' ? d : Date.parse(d.length === 10 ? d + 'T00:00:00Z' : d);
const fD = d => { if (d == null) return '—'; const x = new Date(ms(d)); return x.getUTCDate() + ' ' + MON[x.getUTCMonth()] + ' ' + x.getUTCFullYear(); };
const p2 = n => String(n).padStart(2, '0');
const fT = d => { if (d == null) return '—'; const x = new Date(ms(d)); return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate()) + ' ' + p2(x.getUTCHours()) + ':' + p2(x.getUTCMinutes()) + ' UTC'; };
const rel = d => { const df = NOW - ms(d), a = Math.abs(df); const f = a < H ? Math.max(1, Math.round(a / 6e4)) + ' min' : a < 2 * D ? Math.round(a / H) + ' h' : Math.round(a / D) + ' d'; return df >= 0 ? f + ' ago' : 'in ' + f; };
const money = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const TONE = { ok:['#1F7A4D','#E3F1EA'], info:['#2C6FB3','#E6EFF8'], warn:['#946011','#FAF0DC'], danger:['#A8412F','#F7E7E3'], neutral:['#3F4A55','#EBEEF2'], muted:['#66717B','#F0F2F4'] };
const pill = (label, tone) => ({ label, fg: TONE[tone][0], bg: TONE[tone][1] });

const ROLE = { platform_owner:'Platform owner', finance_admin:'Finance admin', commercial_ops:'Commercial ops', catalog_manager:'Catalog manager', support_admin:'Support admin', read_only_auditor:'Read-only auditor' };
const STEP = { finance_admin:'Finance', platform_owner:'Owner' };
const PEOPLE = {
  maya:{ name:'Maya Okafor', initials:'MO', email:'maya.okafor@aramo.ai', human:true, sa:true, roles:[] },
  daniel:{ name:'Daniel Reyes', initials:'DR', email:'daniel.reyes@aramo.ai', human:true, roles:['platform_owner'] },
  priya:{ name:'Priya Shah', initials:'PS', email:'priya.shah@aramo.ai', human:true, roles:['finance_admin'] },
  tomas:{ name:'Tomás Silva', initials:'TS', email:'tomas.silva@aramo.ai', human:true, roles:['commercial_ops'] },
  lena:{ name:'Lena Fischer', initials:'LF', email:'lena.fischer@aramo.ai', human:true, roles:['catalog_manager'] },
  kwame:{ name:'Kwame Mensah', initials:'KM', email:'kwame.mensah@aramo.ai', human:true, roles:['support_admin'], removed:{ finance_admin: ago(20) } },
  ines:{ name:'Ines Duarte', initials:'ID', email:'ines.duarte@aramo.ai', human:true, roles:['read_only_auditor'] },
  arjun:{ name:'Arjun Rao', initials:'AR', email:'arjun.rao@aramo.ai', human:true, roles:['finance_admin','platform_owner'] },
  svc:{ name:'billing-sync', initials:'BS', email:'svc.billing-sync@aramo.ai', human:false, roles:['finance_admin'] },
  system:{ name:'Migration job', initials:'MJ', email:'—', human:false, roles:[] },
};
const PERSONAS = ['maya','daniel','priya','tomas','lena','kwame','ines','arjun','svc'];
const ROSTER = { ready:['maya','daniel','priya','tomas','lena','kwame','ines','arjun'], notBootstrapped:['maya','arjun','tomas','lena'] };
const CHAINS = {
  ABOVE:{ label:'Above threshold', steps:['finance_admin','platform_owner'], makers:['commercial_ops','support_admin'] },
  BELOW:{ label:'Below threshold', steps:['finance_admin'], makers:['commercial_ops','support_admin'] },
  CATALOG:{ label:'Catalog publish', steps:['finance_admin','platform_owner'], makers:['catalog_manager'] },
  PRIV:{ label:'Role change (privileged)', steps:['platform_owner'], makers:['platform_owner'] },
  POLICY:{ label:'Policy change', steps:['finance_admin','platform_owner'], makers:['platform_owner','finance_admin'] },
};
const TYPE = { PLAN_CHANGE:'Plan change', CANCEL:'Cancel subscription', GRANT:'Grant product', REVOKE:'Revoke product', CREDIT:'Account credit', DISCOUNT:'Discount', EXTENSION:'Support extension', RECON:'Reconciliation release', CATALOG_PUBLISH:'Publish plan version', CATALOG_RETIRE:'Retire plan version', POLICY_ACTIVATE:'Activate policy version', ROLE_CHANGE:'Role change', CONTRACT_AMEND:'Contract amendment', CONTRACT_END:'End contract' };
const MAKERS = { PLAN_CHANGE:['commercial_ops'], CANCEL:['commercial_ops'], GRANT:['commercial_ops'], REVOKE:['commercial_ops'], CREDIT:['commercial_ops'], DISCOUNT:['commercial_ops'], RECON:['commercial_ops'], EXTENSION:['support_admin'], CATALOG_PUBLISH:['catalog_manager'], CATALOG_RETIRE:['catalog_manager'], CATALOG_DRAFT:['catalog_manager'], POLICY_ACTIVATE:['platform_owner','finance_admin'], ROLE_CHANGE:['platform_owner'], CONTRACT_AMEND:['commercial_ops'], CONTRACT_END:['commercial_ops'] };
const SIDES = { PLAN_CHANGE:[1,1], CANCEL:[1,1], GRANT:[0,1], REVOKE:[0,1], CREDIT:[1,0], DISCOUNT:[1,0], EXTENSION:[1,0], RECON:[1,0], CONTRACT_AMEND:[1,0], CONTRACT_END:[1,1] };
const CRS = { DRAFT:['Draft','neutral'], PENDING_APPROVAL:['Pending approval','info'], APPROVED:['Approved','info'], APPLYING:['Applying','info'], APPLIED:['Applied','ok'], APPLY_FAILED:['Apply failed','danger'], REJECTED:['Rejected','muted'], EXPIRED:['Expired','muted'], WITHDRAWN:['Withdrawn','muted'] };
const PROD = { sign:'Aramo Sign', ats:'ATS', portal:'Portal', intelligence:'Intelligence' };
const SUBST = { ACTIVE:['Active','ok'], PAST_DUE:['Past due','warn'], SUSPENDED:['Suspended','danger'], ENDED:['Ended','muted'] };
const EVT = { CR_SUBMITTED:'Change request submitted', CR_DRAFTED:'Change request drafted', STEP_SIGNED:'Approval step signed', CR_REJECTED:'Change request rejected', CR_EXPIRED:'Change request expired', CR_WITHDRAWN:'Change request withdrawn', CR_APPLIED:'Change applied', CR_APPLY_FAILED:'Apply failed', STRIPE_SENT:'Sent to Stripe', STRIPE_CONFIRMED:'Stripe confirmed (webhook)', APPLY_RETRIED:'Apply retried', EXTENSION_EXCEPTION:'Support extension applied (exception)', ROLE_REMOVED:'Role removed', MIGRATED:'Subscription migrated', RECON_FLAGGED:'Reconciliation flag raised', APPROVAL_REFUSED:'Approval refused', AUDIT_EXPORTED:'Audit exported', CATALOG_DRAFTED:'Plan version drafted' };

const T0 = [
  { id:'t_halcyon', name:'Halcyon Health', slug:'halcyon', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'enterprise', ver:1, source:'MANUAL', status:'ACTIVE', ps:'2026-10-08', pe:'2026-11-07', grace:null, susp:null, used:18240, allow:25000, commitEnd:'2026-12-08', contract:'CT-2024-007' }, ent:{ state:'ACTIVE', prov:'MIGRATION', ref:'MIG-2025-11', at:'2025-11-14' } },
    ats:{ sub:null, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2023-12-08' } }, portal:{ sub:null, ent:{ state:'NONE' } },
    intelligence:{ sub:null, ent:{ state:'ACTIVE', prov:'CHANGE_REQUEST', ref:'CR-1038', at: ago(290) } } } },
  { id:'t_atlas', name:'Atlas Freight', slug:'atlas-freight', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'business', ver:2, source:'MANUAL', status:'ACTIVE', ps:'2026-10-01', pe:'2026-10-31', used:2140, allow:3000, commitEnd:'2027-04-30', contract:'CT-2026-021' }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2026-05-01' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'ACTIVE', prov:'CHANGE_REQUEST', ref:'CR-0988', at:'2026-06-10' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_meridian', name:'Meridian Partners', slug:'meridian', status:'ACTIVE', ext:[], recon:{ at:'2026-10-21T09:12:00Z', detail:'A self-service checkout for Sign Team would have ended the governed MANUAL subscription on contract CT-2025-014. Checkout was blocked.', cr:'CR-1051' }, products:{
    sign:{ sub:{ plan:'scale', ver:1, source:'MANUAL', status:'ACTIVE', ps:'2026-10-15', pe:'2026-11-14', used:4410, allow:10000, commitEnd:'2027-03-14', contract:'CT-2025-014' }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2025-03-15' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'NONE' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_northwind', name:'Northwind Logistics', slug:'northwind', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'team', ver:2, source:'SELF_SERVICE', status:'ACTIVE', ps:'2026-10-10', pe:'2026-11-09', used:412, allow:750 }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2026-02-02' } },
    ats:{ sub:null, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2026-02-02' } }, portal:{ sub:null, ent:{ state:'NONE' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_fernhill', name:'Fernhill Studio', slug:'fernhill', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'starter', ver:1, source:'SELF_SERVICE', status:'PAST_DUE', ps:'2026-09-22', pe:'2026-10-22', grace:'2026-10-29', used:96, allow:100 }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2026-03-22' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'NONE' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_oakridge', name:'Oakridge Dental', slug:'oakridge', status:'ACTIVE', recon:null,
    ext:[{ id:'EXT-0042', days:10, at:'2026-10-03T16:40:00Z', by:'kwame', roles:['support_admin','finance_admin'], clause:'Policy v0 §4.2 — up to 14 days per use, once per tenant per 90 days, 30 days cumulative', policy:0, cumBefore:0, cumAfter:10 }], products:{
    sign:{ sub:{ plan:'starter', ver:2, source:'SELF_SERVICE', status:'ACTIVE', ps:'2026-10-05', pe:'2026-11-04', used:61, allow:150 }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2026-04-05' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'NONE' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_brightline', name:'Brightline Retail', slug:'brightline', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'business', ver:1, source:'MANUAL', status:'ENDED', ps:'2026-09-18', pe:'2026-10-17', ended:'2026-10-18', used:0, allow:3000, commitEnd:'2026-10-17', contract:'CT-2024-019' }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2024-10-18' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'REVOKED', prov:'PROVISIONING', at:'2025-01-10', revokedAt:'2026-10-02', revokeRef:'CR-1032' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
  { id:'t_quarry', name:'Quarry Lane Legal', slug:'quarry-lane', status:'ACTIVE', ext:[], recon:null, products:{
    sign:{ sub:{ plan:'team', ver:1, source:'SELF_SERVICE', status:'SUSPENDED', ps:'2026-09-08', pe:'2026-10-07', grace:'2026-10-14', susp:'2026-10-15', used:500, allow:500 }, ent:{ state:'ACTIVE', prov:'PROVISIONING', at:'2025-09-08' } },
    ats:{ sub:null, ent:{ state:'NONE' } }, portal:{ sub:null, ent:{ state:'NONE' } }, intelligence:{ sub:null, ent:{ state:'NONE' } } } },
];

const P0 = [
  { id:'starter', name:'Starter', vers:[{ v:1, status:'PUBLISHED', price:19, env:100, seats:1, gb:5, pub:'2026-01-15' }, { v:2, status:'PUBLISHED', price:24, env:150, seats:1, gb:10, pub:'2026-07-01' }] },
  { id:'team', name:'Team', vers:[{ v:1, status:'PUBLISHED', price:49, env:500, seats:5, gb:25, pub:'2026-01-15' }, { v:2, status:'PUBLISHED', price:59, env:750, seats:5, gb:50, pub:'2026-07-01' }, { v:3, status:'DRAFT', price:69, env:1000, seats:10, gb:50, cr:'CR-1044' }] },
  { id:'business', name:'Business', vers:[{ v:1, status:'RETIRED', price:129, env:3000, seats:25, gb:200, pub:'2025-02-01', ret:'2026-07-01' }, { v:2, status:'PUBLISHED', price:139, env:3000, seats:25, gb:200, pub:'2026-07-01' }] },
  { id:'scale', name:'Scale', vers:[{ v:1, status:'PUBLISHED', price:299, env:10000, seats:100, gb:1000, pub:'2025-02-01' }] },
  { id:'enterprise', name:'Enterprise', contractOnly:true, vers:[{ v:1, status:'PUBLISHED', price:null, env:25000, seats:500, gb:5000, pub:'2025-02-01' }] },
];

const POL0 = [
  { v:2, status:'DRAFT', note:'Tighten the credit threshold and approval window after the Q3 review.', created:'2026-10-24T09:00:00Z', by:'priya', vals:{ disc:20, credit:300, extDays:14, extWin:90, extCum:30, ttl:48, grace:7 } },
  { v:1, status:'ACTIVE', note:'First governed commercial policy.', created:'2026-10-20T10:00:00Z', activated:'2026-10-23T10:00:00Z', by:'daniel', vals:{ disc:20, credit:500, extDays:14, extWin:90, extCum:30, ttl:72, grace:7 } },
  { v:0, status:'RETIRED', note:'Pilot policy.', created:'2026-07-28T10:00:00Z', activated:'2026-08-01T00:00:00Z', retired:'2026-10-23T10:00:00Z', by:'daniel', vals:{ disc:25, credit:1000, extDays:14, extWin:90, extCum:30, ttl:72, grace:7 } },
];
const PFIELDS = [
  ['disc','Discount approval threshold', v => v + '%', 'Discounts above this need Finance → Owner; at or below, Finance only.', 0, 100],
  ['credit','Credit approval threshold', v => money(v), 'Credits above this need Finance → Owner; at or below, Finance only.', 0, 100000],
  ['extDays','Support extension, per use', v => v + ' days', 'Within bounds, an extension applies with zero approvals as an exception.', 1, 60],
  ['extWin','Support extension frequency', v => 'once per tenant per ' + v + ' days', 'Rolling window.', 30, 365],
  ['extCum','Support extension, cumulative cap', v => v + ' days', 'Total extension days inside the window.', 1, 120],
  ['ttl','Approval window (TTL)', v => v + ' h', 'A request expires if its chain isn’t complete in time.', 12, 168],
  ['grace','Past-due grace', v => v + ' days', 'Days after a failed payment before the subscription is suspended.', 0, 30],
];

const C0 = [
  { id:'CT-2024-007', tenant:'t_halcyon', plan:'enterprise', months:36, start:'2023-12-08', end:'2026-12-08', status:'ACTIVE', migrated:true,
    terms:['Sign Enterprise at $2,400 per month, negotiated (SAMPLE)','Allowance of 25,000 envelopes per month','Invoiced monthly, net 45','Price held for the commitment term'],
    docs:[['Master services agreement.pdf','sha256:9f2c61d0…a84b1e','tomas','2023-12-04'],['Order form OF-7781.pdf','sha256:51ad09fe…37e07c','tomas','2023-12-04'],['Amendment 1.pdf','sha256:c3e04b77…119a42','tomas','2024-06-11']],
    amend:[['2023-12-08','Contract recorded','36-month commitment signed.','tomas'],['2024-06-11','Amendment 1','Allowance raised from 20,000 to 25,000 envelopes per month.','tomas'],['2025-11-14','Migrated into the commercial control plane','Backfilled from legacy billing. Provenance: migration.','system']] },
  { id:'CT-2026-021', tenant:'t_atlas', plan:'business', months:12, start:'2026-05-01', end:'2027-04-30', status:'ACTIVE',
    terms:['Sign Business v2 at list price (SAMPLE)','Portal included from June 2026','Invoiced monthly, net 30'],
    docs:[['Order form OF-8034.pdf','sha256:0be771c2…d5f310','tomas','2026-04-28']],
    amend:[['2026-05-01','Contract recorded','12-month commitment signed.','tomas'],['2026-06-10','Portal added','Portal entitlement granted through CR-0988.','tomas']] },
  { id:'CT-2025-014', tenant:'t_meridian', plan:'scale', months:24, start:'2025-03-15', end:'2027-03-14', status:'ACTIVE',
    terms:['Sign Scale v1 at $260 per month, negotiated (SAMPLE)','Invoiced quarterly, net 30'],
    docs:[['Master services agreement.pdf','sha256:7a19c3e5…0f62bd','tomas','2025-03-10'],['Order form OF-7920.pdf','sha256:e2d48a01…b9c774','tomas','2025-03-10']],
    amend:[['2025-03-15','Contract recorded','24-month commitment signed.','tomas'],['2026-10-21','Reconciliation flag','A self-service checkout was blocked to protect this contract.','system']] },
  { id:'CT-2024-019', tenant:'t_brightline', plan:'business', months:24, start:'2024-10-18', end:'2026-10-17', status:'ENDED',
    terms:['Sign Business v1 at list price (SAMPLE)','Not renewed'],
    docs:[['Order form OF-7702.pdf','sha256:44f0be13…7c2a09','tomas','2024-10-15']],
    amend:[['2024-10-18','Contract recorded','24-month commitment signed.','tomas'],['2026-10-18','Contract ended','Subscription ended at commitment end through CR-1046.','tomas']] },
];

const mk = (o) => Object.assign({ steps:[], diff:[], apply:null, extra:[] }, o);
const CR0 = [
  mk({ id:'CR-1041', type:'PLAN_CHANGE', tenant:'t_atlas', product:'sign', summary:'Business v2 → Scale v1 with a 25% discount', chain:'ABOVE', policy:1, by:'tomas', created:ago(31), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin', by:'priya', at:ago(20) },{ r:'platform_owner' }],
    diff:[['Plan','Sign Business (SAMPLE)','Sign Scale (SAMPLE)'],['Plan version','v2','v1'],['Price','$139 / month','$224.25 / month'],['Discount','None','25%'],['Allowance','3,000 envelopes','10,000 envelopes']],
    reason:'Atlas is adding two regional hiring teams. The 25% discount was agreed on the renewal call.', evidence:'Renewal call notes, 21 Oct 2026 (DOC-5512)', fx:{ k:'plan', t:'t_atlas', p:'sign', plan:'scale', ver:1 } }),
  mk({ id:'CR-1042', type:'CREDIT', tenant:'t_northwind', product:'sign', summary:'$350 account credit', chain:'BELOW', policy:1, by:'tomas', created:ago(5), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin' }], stripe:true,
    diff:[['Account credit','$0','$350'],['Applied to','—','Next Stripe invoice']], reason:'Envelopes failed to send during the 18 Oct incident.', evidence:'Incident INC-2210' }),
  mk({ id:'CR-1043', type:'DISCOUNT', tenant:'t_halcyon', product:'sign', summary:'30% renewal discount', chain:'ABOVE', policy:1, by:'tomas', created:ago(26), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin', by:'arjun', at:ago(22) },{ r:'platform_owner' }],
    diff:[['Discount','None','30%'],['Price','$2,400 / month','$1,680 / month'],['Applies from','—','8 Dec 2026 (renewal)']], reason:'Renewal for a further 24 months.', evidence:'Draft renewal order form OF-8120' }),
  mk({ id:'CR-1044', type:'CATALOG_PUBLISH', tenant:null, product:'sign', summary:'Publish Sign Team v3', chain:'CATALOG', policy:1, by:'lena', created:ago(3), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin' },{ r:'platform_owner' }],
    diff:[['Price','$59 / month','$69 / month'],['Envelopes per month','750','1,000'],['Seats','5','10'],['Storage','50 GB','50 GB']], reason:'Annual price review. Existing Team tenants stay on their pinned version.', evidence:'Pricing review PR-2026-Q4', fx:{ k:'publish', plan:'team', ver:3 } }),
  mk({ id:'CR-1045', type:'ROLE_CHANGE', tenant:null, product:null, summary:'Grant Finance admin to Ines Duarte', chain:'PRIV', policy:1, by:'daniel', created:ago(8), state:'PENDING_APPROVAL', steps:[{ r:'platform_owner' }],
    diff:[['Ines Duarte','Read-only auditor','Read-only auditor, Finance admin']], reason:'Cover for Finance during the Q4 close.', evidence:'Staffing note HR-3391', fx:{ k:'roles', who:'ines', roles:['read_only_auditor','finance_admin'] } }),
  mk({ id:'CR-1046', type:'CANCEL', tenant:'t_brightline', product:'sign', summary:'End Sign at commitment end', chain:'ABOVE', policy:0, by:'tomas', created:ago(150), state:'APPLY_FAILED', steps:[{ r:'finance_admin', by:'priya', at:ago(140) },{ r:'platform_owner', by:'daniel', at:ago(138) }],
    apply:{ sub:'done', ent:'failed', err:'ENTITLEMENT_REVOKE_TIMEOUT' }, endAt:ago(138), endBy:'system', endReason:'Subscription ended; entitlement revoke timed out (ENTITLEMENT_REVOKE_TIMEOUT)',
    diff:[['Subscription','Active','Ended 18 Oct 2026'],['Sign entitlement','Active','Revoked']], reason:'Brightline chose not to renew.', evidence:'Non-renewal notice, 30 Sep 2026', fx:{ k:'cancel', t:'t_brightline', p:'sign' } }),
  mk({ id:'CR-1047', type:'DISCOUNT', tenant:'t_meridian', product:'sign', summary:'28% loyalty discount', chain:'ABOVE', policy:0, by:'tomas', created:ago(120), state:'EXPIRED', steps:[{ r:'finance_admin', by:'priya', at:ago(110) },{ r:'platform_owner' }], endAt:ago(48), endBy:'system', endReason:'Owner step not signed within 72 h',
    diff:[['Discount','None','28%'],['Price','$260 / month','$187.20 / month']], reason:'Loyalty discount for the second contract year.', evidence:'Account review AR-311' }),
  mk({ id:'CR-1048', type:'CREDIT', tenant:'t_meridian', product:'sign', summary:'$900 account credit', chain:'ABOVE', policy:0, by:'tomas', created:ago(90), state:'REJECTED', steps:[{ r:'finance_admin' },{ r:'platform_owner' }], endAt:ago(60), endBy:'priya', endReason:'No evidence of the service incident was attached.',
    diff:[['Account credit','$0','$900']], reason:'Service incident in September.', evidence:'—' }),
  mk({ id:'CR-1039', type:'CREDIT', tenant:'t_halcyon', product:'sign', summary:'$650 account credit', chain:'BELOW', policy:0, by:'tomas', created:ago(40), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin' }],
    note:'Under policy v1 a $650 credit is above the $500 threshold and would need Finance → Owner. This request keeps the Finance-only chain it was created with under v0 ($1,000 threshold).',
    diff:[['Account credit','$0','$650'],['Applied to','—','Next invoice']], reason:'Allowance overage billed in error in September.', evidence:'Invoice INV-2026-0912 line 4' }),
  mk({ id:'CR-1049', type:'GRANT', tenant:'t_northwind', product:'portal', summary:'Grant Portal', chain:'BELOW', policy:1, by:'tomas', created:ago(1), state:'DRAFT', steps:[{ r:'finance_admin' }],
    diff:[['Portal entitlement','Not granted','Active']], reason:'Pilot for the candidate portal.', evidence:'', fx:{ k:'grant', t:'t_northwind', p:'portal' } }),
  mk({ id:'CR-1050', type:'CONTRACT_AMEND', tenant:'t_atlas', product:'sign', summary:'Raise allowance to 4,000 envelopes', chain:'ABOVE', policy:0, by:'tomas', created:ago(80), state:'WITHDRAWN', steps:[{ r:'finance_admin' },{ r:'platform_owner' }], endAt:ago(70), endBy:'tomas', endReason:'Replaced by the plan change in CR-1041.',
    diff:[['Allowance','3,000 envelopes','4,000 envelopes']], reason:'Seasonal volume.', evidence:'Email from Atlas, 19 Oct' }),
  mk({ id:'CR-1051', type:'RECON', tenant:'t_meridian', product:'sign', summary:'Release reconciliation flag', chain:'BELOW', policy:1, by:'tomas', created:ago(26), state:'APPLYING', stripe:true, steps:[{ r:'finance_admin', by:'priya', at:ago(24) }],
    apply:{ sub:'sent', ent:'unchanged' }, endAt:ago(24), endBy:'system', endReason:'Cancel of the blocked self-service checkout sent to Stripe',
    diff:[['Self-service checkout subscription','Blocked (incomplete)','Cancelled in Stripe'],['MANUAL subscription CT-2025-014','Active','Active (unchanged)'],['Reconciliation flag','Open','Released']],
    reason:'Meridian stays on its contract. The checkout was started by a new team member.', evidence:'Email from Meridian finance, 22 Oct', fx:{ k:'recon', t:'t_meridian' } }),
  mk({ id:'CR-1052', type:'EXTENSION', tenant:'t_oakridge', product:'sign', summary:'+14 day support extension (escalated)', chain:'BELOW', policy:1, by:'kwame', created:ago(4), state:'PENDING_APPROVAL', steps:[{ r:'finance_admin' }],
    note:'Escalated: a second extension inside the 90-day window is outside Policy v1 §4.2, so it needs approval instead of applying as an exception.',
    diff:[['Support extension','10 days used in window','+14 days'],['Cumulative in window','10 days','24 days'],['Stripe billing dates','Unchanged','Unchanged (overlay)']], reason:'The practice moved offices and paperwork was delayed.', evidence:'Support ticket SUP-88213', fx:{ k:'ext', t:'t_oakridge', days:14 } }),
  mk({ id:'CR-1038', type:'GRANT', tenant:'t_halcyon', product:'intelligence', summary:'Grant Intelligence', chain:'ABOVE', policy:0, by:'tomas', created:ago(300), state:'APPLIED', steps:[{ r:'finance_admin', by:'priya', at:ago(296) },{ r:'platform_owner', by:'daniel', at:ago(290) }],
    apply:{ sub:'na', ent:'done' }, endAt:ago(290), endBy:'system', endReason:'Entitlement active',
    diff:[['Intelligence entitlement','Not granted','Active']], reason:'Enterprise add-on in the renewal.', evidence:'Order form OF-7781 schedule B' }),
].map(c => Object.assign(c, { expires: c.created + 72 * H }));

function buildAudit(crs) {
  const ev = [];
  crs.forEach(c => {
    ev.push({ at:c.created, actor:c.by, type: c.state === 'DRAFT' ? 'CR_DRAFTED' : 'CR_SUBMITTED', cr:c.id, tenant:c.tenant, product:c.product, detail:c.summary });
    c.steps.forEach(s => s.by && ev.push({ at:s.at, actor:s.by, type:'STEP_SIGNED', cr:c.id, tenant:c.tenant, product:c.product, detail: STEP[s.r] + ' step signed' }));
    const tt = { REJECTED:'CR_REJECTED', EXPIRED:'CR_EXPIRED', WITHDRAWN:'CR_WITHDRAWN', APPLIED:'CR_APPLIED', APPLY_FAILED:'CR_APPLY_FAILED', APPLYING:'STRIPE_SENT' }[c.state];
    if (tt) ev.push({ at:c.endAt, actor:c.endBy, type:tt, cr:c.id, tenant:c.tenant, product:c.product, detail:c.endReason });
  });
  ev.push({ at:ms('2026-10-03T16:40:00Z'), actor:'kwame', roles:['support_admin','finance_admin'], type:'EXTENSION_EXCEPTION', exc:true, tenant:'t_oakridge', product:'sign', detail:'+10 days · Policy v0 §4.2 · use 1 of 1 in 90 days · cumulative 0 → 10 days' });
  ev.push({ at:ms('2025-11-14T03:00:00Z'), actor:'system', type:'MIGRATED', tenant:'t_halcyon', product:'sign', detail:'CT-2024-007 backfilled from legacy billing (provenance: migration)' });
  ev.push({ at:ms('2026-10-21T09:12:00Z'), actor:'system', type:'RECON_FLAGGED', tenant:'t_meridian', product:'sign', detail:'Self-service checkout blocked; MANUAL subscription unchanged' });
  ev.push({ at:ago(20), actor:'daniel', type:'ROLE_REMOVED', detail:'Finance admin removed from Kwame Mensah (CR-1036)' });
  ev.sort((a, b) => a.at - b.at);
  return ev.map((e, i) => Object.assign(e, { id:'ev_' + (4700 + i) })).reverse();
}

window.CCP = { NOW, H, D, ago, ms, fD, fT, rel, money, TONE, pill, ROLE, STEP, PEOPLE, PERSONAS, ROSTER, CHAINS, TYPE, MAKERS, SIDES, CRS, PROD, SUBST, EVT, T0, P0, POL0, PFIELDS, C0, CR0, buildAudit };
})();
