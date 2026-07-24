// Front-Door PR-2 (Ruling 6) — the deploy-path wall for nginx front-door conf
// semantics. Modeled on the refusal-check family. Asserts, against the template
// and compose AS TEXT, the walls that keep the nginx front door faithful to the
// Caddy one, plus the PR-2 inertness invariant.
//
// Assertions (directive §2.6):
//   (a) the webhook route literal from apps/api/src/webhooks/indeed-apply.constants.ts
//       appears in the TENANT block as an exact-match location with
//       `client_max_body_size 3m` — constant/conf parity, both read fresh here.
//   (b) the ADMIN server block contains NO `/v1` location token (R14 negative control).
//   (c) the PORTAL block's only `/v1` location is `/v1/portal/`.
//   (d) all four Ruling-3 header lines are present in each proxied (443) server block.
//   (e) the certbot issuance documentation is WILDCARD-ONLY (contains `-d '*.aramo.ai'`,
//       NOT a bare `-d aramo.ai`) per Ruling 4 / PR-0b R4.
//   (f) both new compose services carry `profiles: ["frontdoor"]` and nginx has no
//       `ports:` — the inertness invariant as an executable check. RETIRES at PR-3
//       (the flip removes the profiles and adds nginx ports); update (f) then.
//
// PATH-COUPLING (standing lesson): this script references files by literal path.
// Any future move of deploy/nginx/** or the constants file must grep for it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const R = (p: string): string => resolve(ROOT, p);

const CONSTANTS = 'apps/api/src/webhooks/indeed-apply.constants.ts';
const TEMPLATE = 'deploy/nginx/templates/aramo.conf.template';
const COMPOSE = 'docker-compose.prod.yml';

const HEADER_LINES = [
  'proxy_set_header Host',
  'proxy_set_header X-Forwarded-For',
  'proxy_set_header X-Forwarded-Host',
  'proxy_set_header X-Forwarded-Proto',
];

interface Issue {
  where: string;
  reason: string;
}

// Extract the balanced-brace body of each `server { … }` block, tagged by which
// NGINX_*_SERVER_NAME (or the port-80 default) it declares.
function serverBlocks(template: string): Array<{ tag: string; body: string }> {
  const out: Array<{ tag: string; body: string }> = [];
  let i = 0;
  while (true) {
    const start = template.indexOf('server {', i);
    if (start === -1) break;
    let depth = 0;
    let j = template.indexOf('{', start);
    const bodyStart = j + 1;
    for (; j < template.length; j++) {
      if (template[j] === '{') depth++;
      else if (template[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = template.slice(bodyStart, j);
    let tag = 'unknown';
    if (body.includes('${NGINX_TENANT_SERVER_NAME}')) tag = 'tenant';
    else if (body.includes('${NGINX_ADMIN_SERVER_NAME}')) tag = 'admin';
    else if (body.includes('${NGINX_PORTAL_SERVER_NAME}')) tag = 'portal';
    else if (/listen\s+80\b/.test(body)) tag = 'port80';
    out.push({ tag, body });
    i = j + 1;
  }
  return out;
}

function parseWebhookRoute(constantsSrc: string): string | null {
  const m = constantsSrc.match(
    /INDEED_APPLY_WEBHOOK_ROUTE\s*=\s*'([^']+)'/,
  );
  return m ? m[1] : null;
}

function checkRepo(): Issue[] {
  const issues: Issue[] = [];
  const constantsSrc = readFileSync(R(CONSTANTS), 'utf8');
  const template = readFileSync(R(TEMPLATE), 'utf8');
  const compose = readFileSync(R(COMPOSE), 'utf8');

  const blocks = serverBlocks(template);
  const tenant = blocks.find((b) => b.tag === 'tenant');
  const admin = blocks.find((b) => b.tag === 'admin');
  const portal = blocks.find((b) => b.tag === 'portal');
  const ssl = blocks.filter((b) => ['tenant', 'admin', 'portal'].includes(b.tag));

  if (!tenant || !admin || !portal) {
    issues.push({ where: TEMPLATE, reason: 'missing one of tenant/admin/portal server blocks' });
    return issues;
  }

  // (a) webhook parity — constant appears in the tenant block as an exact-match
  // location carrying client_max_body_size 3m.
  const route = parseWebhookRoute(constantsSrc);
  if (route === null) {
    issues.push({ where: CONSTANTS, reason: 'INDEED_APPLY_WEBHOOK_ROUTE literal not found' });
  } else {
    const loc = `location = ${route}`;
    const idx = tenant.body.indexOf(loc);
    if (idx === -1) {
      issues.push({ where: TEMPLATE, reason: `(a) tenant block missing exact-match "${loc}"` });
    } else {
      // The client_max_body_size 3m must be inside this location's block.
      const braceStart = tenant.body.indexOf('{', idx);
      let depth = 0;
      let k = braceStart;
      for (; k < tenant.body.length; k++) {
        if (tenant.body[k] === '{') depth++;
        else if (tenant.body[k] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const locBody = tenant.body.slice(braceStart, k);
      if (!/client_max_body_size\s+3m\b/.test(locBody)) {
        issues.push({ where: TEMPLATE, reason: '(a) webhook location missing client_max_body_size 3m' });
      }
      if (!/proxy_pass\s+http:\/\/api:3000/.test(locBody)) {
        issues.push({ where: TEMPLATE, reason: '(a) webhook location does not proxy_pass to api:3000' });
      }
    }
  }

  // (b) admin block — NO `/v1` location token (R14 negative control).
  if (/location\s*=?\s*\/v1/.test(admin.body)) {
    issues.push({ where: TEMPLATE, reason: '(b) admin block contains a /v1 location — R14 violation' });
  }

  // (c) portal block — the only /v1 location is /v1/portal/.
  const portalV1 = [...portal.body.matchAll(/location\s*=?\s*(\/v1\S*)/g)].map((m) => m[1]);
  const badPortal = portalV1.filter((l) => l !== '/v1/portal/');
  if (badPortal.length > 0) {
    issues.push({ where: TEMPLATE, reason: `(c) portal block has non-portal /v1 location(s): ${badPortal.join(', ')}` });
  }
  if (!portalV1.includes('/v1/portal/')) {
    issues.push({ where: TEMPLATE, reason: '(c) portal block missing /v1/portal/ location' });
  }

  // (d) all four header lines present in each 443 server block.
  for (const b of ssl) {
    for (const h of HEADER_LINES) {
      if (!b.body.includes(h)) {
        issues.push({ where: TEMPLATE, reason: `(d) ${b.tag} block missing header "${h}"` });
      }
    }
  }

  // (e) certbot issuance documentation — wildcard-only.
  if (!compose.includes("-d '*.aramo.ai'")) {
    issues.push({ where: COMPOSE, reason: "(e) certbot issuance docs missing -d '*.aramo.ai'" });
  }
  if (/-d\s+aramo\.ai(?![.\w*])/.test(compose)) {
    issues.push({ where: COMPOSE, reason: '(e) certbot issuance docs contain a bare -d aramo.ai (apex SAN forbidden — PR-0b R4)' });
  }

  // (f) inertness invariant — both new services profile-gated; nginx has no ports.
  const nginxSvc = extractComposeService(compose, 'nginx');
  const certbotSvc = extractComposeService(compose, 'certbot');
  if (nginxSvc === null) issues.push({ where: COMPOSE, reason: '(f) nginx service not found' });
  if (certbotSvc === null) issues.push({ where: COMPOSE, reason: '(f) certbot service not found' });
  for (const [name, svc] of [['nginx', nginxSvc], ['certbot', certbotSvc]] as const) {
    if (svc && !/profiles:\s*\[\s*["']frontdoor["']\s*\]/.test(svc)) {
      issues.push({ where: COMPOSE, reason: `(f) ${name} service missing profiles: ["frontdoor"]` });
    }
  }
  if (nginxSvc && /^\s*ports:/m.test(nginxSvc)) {
    issues.push({ where: COMPOSE, reason: '(f) nginx service has ports: — inertness invariant violated (port publication is the PR-3 flip)' });
  }

  return issues;
}

// Extract a top-level compose service body (from `  <name>:` to the next
// same-indent `  <key>:` or the `volumes:` block).
function extractComposeService(compose: string, name: string): string | null {
  const lines = compose.split('\n');
  const startRe = new RegExp(`^  ${name}:\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) || /^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function main(): void {
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`frontdoor:conf-check ok (${TEMPLATE} + ${COMPOSE} vs ${CONSTANTS})`);
    return;
  }
  console.error(`frontdoor:conf-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.where}: ${i.reason}`);
  process.exit(1);
}

main();
