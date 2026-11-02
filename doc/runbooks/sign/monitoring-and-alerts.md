# Runbook — Production monitoring and alerts (Aramo Sign launch)

**Status:** v1.0, 2026-11-01. Prepared under the PO instruction of 2026-11-01 ("complete … now before
next deployment"). **Nothing here is applied or installed yet**: §2 (Terraform apply, Mac) and §3 (box
install) are PO-authorized operator steps.

| Piece | Where | What it does |
|---|---|---|
| On-box probe | `deploy/monitoring/aramo-health-probe.sh`, run every 5 min by `deploy/systemd/aramo-health-probe.{service,timer}` | Containers, disk, memory, front-door routes through the local nginx, TLS expiry, nginx 5xx, Sign log signals, backup heartbeat → SNS email on change + CloudWatch metrics |
| Off-box watchdog | `infrastructure-monitoring/lambda/watchdog.py` (EventBridge every 5 min) | Public URLs, served certificates, the probe heartbeat → SNS email on change. Catches "box down" and "probe dead" |
| Backup freshness | `infrastructure-backups/monitoring.tf` + `lambda/freshness.py` (daily, already in the repo, M-A8) | Newest routine backup, newest heartbeat status, newest PASS restore test → its own SNS topic |
| Terraform | `infrastructure-monitoring/` (own state key `monitoring/terraform.tfstate`) | SNS topic `aramo-prod-ops-alerts` + email subscription, IAM user `aramo-prod-monitoring-publisher` (publish-only), the watchdog Lambda, its SSM state parameter |
| Install | `deploy/monitoring/install.sh` | Preflight, dry run, systemd install |

## 1. Design

```
 box (astre.aramo.ai)                                   AWS us-east-1
 ┌──────────────────────────────────────┐
 │ aramo-health-probe.timer (5 min)     │  put-metric-data   ┌──────────────────────┐
 │  └ aramo-health-probe.sh  ───────────┼───────────────────►│ CloudWatch Aramo/Prod │
 │     docker inspect / logs, df,       │                    └──────────┬───────────┘
 │     /proc/meminfo, curl --resolve    │  sns publish                  │ GetMetricStatistics
 │     <host>:443:127.0.0.1, openssl    ├──────────┐                    │ (ProbeHeartbeat)
 │     backup heartbeat files           │          ▼                    ▼
 └──────────────────────────────────────┘   ┌──────────────┐    ┌────────────────────┐
                                            │ SNS          │◄───┤ watchdog Lambda    │
                                            │ aramo-prod-  │    │ (5 min): public    │
                                            │ ops-alerts   │    │ URLs, TLS, heartbeat│
                                            └──────┬───────┘    └────────────────────┘
                                                   ▼ email (PO-confirmed address)
```

Choices, and why:

- **No CloudWatch alarm resources and no CloudWatch agent.** The probe and the watchdog decide and
  publish themselves, alerting on change (one email when a check starts failing, a reminder every 6 h,
  one on recovery). Same choice as `infrastructure-backups/monitoring.tf`. Nothing to install on the box
  except two systemd units and a 0600 config file; the AWS CLI runs in `amazon/aws-cli:2.17.0` when the
  host has none (same fallback as `deploy/backup/lib.sh` `bk_aws`).
- **Route 53 health checks / CloudWatch Synthetics are not used.** The watchdog Lambda covers the same
  ground (HTTPS status, certificate expiry, reachability from outside) for a few cents a month, with no
  extra alarm wiring. Cost estimate (unverified, list prices): 11 custom metrics at about USD 0.30 each per
  month, Lambda and SNS email within the free tier.
- **Alerts carry no personal data.** Check names, counts, status codes, ages. The probe never forwards log
  lines; the operator reads them on the box.
- **Container health.** api, auth-service, platform-admin and sign-service images declare a TCP
  `HEALTHCHECK` on their port (`apps/<service>/Dockerfile`); nginx, postgres, redis and
  talent-intelligence-service have compose healthchecks. `talent-intake-worker` runs the api image without
  an HTTP port, so its inherited TCP healthcheck always reports `unhealthy`; the probe ignores that one
  health state (`MON_HEALTH_IGNORE`) and still alerts on it stopping or restarting.
- **Health endpoints.** api, auth-service and sign-service expose no `/health` route (only
  talent-intelligence-service does, `apps/talent-intelligence-service/src/app/health.controller.ts`, used by
  its compose healthcheck). The probe and the watchdog use unauthenticated reads instead: a `401` proves the
  request reached the service through nginx; `502/503/504` or no answer means it did not. Expected codes
  (from `docker-compose.prod.yml` header comments and `deploy/nginx/templates/aramo.conf.template` routing):

  | Check | URL | Expected | Routed to |
  |---|---|---|---|
  | tenant-spa | `https://astre.aramo.ai/` | 200 | nginx (baked SPA) |
  | auth-jwks | `https://astre.aramo.ai/.well-known/jwks.json` | 200 | auth-service |
  | api | `https://astre.aramo.ai/v1/tenant/settings` | 401 | api |
  | sign / sign-service | `https://sign.aramo.ai/v1/sign/legal/status` | 401 | sign-service (`apps/sign-service/src/app/legal/sign-legal.controller.ts`, `JwtAuthGuard`) |
  | sign-web (watchdog only) | `https://sign.aramo.ai/` | 200 | nginx (baked Sign SPA) |
  | platform-admin | `https://admin.aramo.ai/platform/me` | 401 | platform-admin |

  **UNVERIFIED against production:** the three `401` and the sign-web `200` were derived from code, not
  observed. §3 step 4 checks them before the timer is trusted.

### 1.1 Checks and thresholds (probe; defaults overridable in `/etc/aramo/monitoring.conf`)

| Check name in the email | Fails when | Default |
|---|---|---|
| `container:<name>` | not running; health `unhealthy`; restart count rose since the previous run | containers = every `container_name` in `docker-compose.prod.yml`; health ignored for `aramo-prod-talent-intake-worker` |
| `disk:/`, `disk:/var/lib/docker` | used % ≥ limit | 85 |
| `memory` | MemAvailable < limit % of MemTotal | 10 |
| `http:<name>` | status not in the expected list (table above) | — |
| `tls:<host>` | served certificate has fewer days left (or cannot be read; openssl missing) | 14 |
| `nginx:5xx` | ≥ 10 responses 5xx **and** ≥ 5 % of requests since the previous run | 10 / 5 % |
| `sign:kms` | a sign-service log line naming a KMS evidence-signing failure | any |
| `sign:custody` | custody upload / completion / reconcile failure, ledger or hash mismatch | any |
| `sign:purge` | purge run, queue or execute failure | any |
| `sign:purge-r13` | `sign_purge.alert_integration_copy_unconfirmed` (R-13: an application envelope purged before its executed copy was confirmed delivered) | any |
| `sign:retention` | retention or convenience-data purge failure | any |
| `sign:privacy` | privacy-request execution failure | any |
| `sign:webhooks` | a vendor webhook (WhatsApp, inbound SMS, Stripe Identity, Stripe Connect, Stripe billing) refused for a wrong signature, a stale timestamp, a wrong SNS topic or certificate, or failed while processing; a Connect payment event refused | any |
| `sign:messaging` | an SMS / WhatsApp provider send error, the send flow failing, a provider asked for but left off at boot, or the inbound-SMS SNS subscription removed | any |
| `sign:tsa-seal` | a trusted timestamp still pending after 10 attempts (`trusted_timestamp.attempts_exceeded`, repeated on every later failed retry), the timestamp retry job failing, a document seal failing for good (`document_seal.attempt_failed … final`) or its retry job failing | any |
| `sign:metering` | a usage report that will never reach Stripe (`usage_report.failed`), the report job failing, reports held because the Stripe key is live-mode, or a delivered SMS / ID check whose usage could not be recorded | any |
| `backup` | newest local heartbeat is FAILED, or the newest OK one is older than the limit; missing directory only fails when `MON_BACKUP_REQUIRED=1` | 26 h |

The Sign patterns are the exact log strings of `apps/sign-service/src/app/kms-evidence-manifest-signer.ts`,
`custody/executed-artifact-custody.service.ts`, `custody/sign-artifact-reconcile.worker.ts`,
`retention/sign-purge.service.ts`, `retention/sign-retention.*.ts`, `privacy/sign-privacy-execution.*.ts`,
`webhook-log.ts`, `payments/sign-payment.service.ts`, `messaging/*.ts`, `trusted-timestamp/*.ts`,
`billing/sign-usage-report.worker.ts`, and in the libraries `libs/sign/src/lib/trusted-timestamp/`,
`libs/sign/src/lib/document-seal/`, `libs/sign/src/lib/identity-verification/` and
`libs/subscription/src/lib/usage/usage-provider-report.service.ts`;
`deploy/monitoring/aramo-health-probe.test.sh` pins them against sample lines. A log-message change in those
files must update `MON_RE_SIGN_*` in the probe in the same PR.

Watchdog checks: `url:<name>` (table above), `tls:<host>` (verify + 14 days), `probe-heartbeat` (no
`ProbeHeartbeat` metric for 20 minutes).

## 2. Terraform apply (Mac only; PO checkpoint)

Never from the box (wrong AWS account; 403 on the state bucket). Account-administrator credentials on the Mac.

```bash
cd infrastructure-monitoring
cp terraform.tfvars.example terraform.tfvars      # set alert_email (PO confirms the address)
terraform init                                     # S3 backend, key monitoring/terraform.tfstate
terraform plan -out monitoring.plan                # expect 12 to add, 0 to change, 0 to destroy (count from this PR's validate; re-check)
terraform apply monitoring.plan
terraform output                                   # ops_alert_topic_arn, publisher_user_name, metric_namespace, host_label
aws iam create-access-key --user-name aramo-prod-monitoring-publisher   # secret shown once → straight into the box config (§3)
```

Then **accept the SNS confirmation email** sent to `alert_email`; until then no alert is delivered.
Until §3 is done the watchdog reports `probe-heartbeat` failing; that first email is expected.

## 3. Box install (PO checkpoint)

1. Land the commit carrying `deploy/monitoring/` on the box the normal way (`RELEASE-box.md` STEP 1). No
   container is rebuilt or recreated by this install.
2. `sudo deploy/monitoring/install.sh` — the first run copies `monitoring.conf.example` to
   `/etc/aramo/monitoring.conf` (root:root 0600) and stops.
3. `sudo nano /etc/aramo/monitoring.conf` — set `MON_SNS_TOPIC_ARN` (terraform output) and the publisher
   key pair. If `.env` or this file is edited, no plaintext copy is made (`RELEASE-box.md` STEP 2 rule).
4. `sudo deploy/monitoring/install.sh --test-alert` — preflight, `--dry-run` table (confirm every
   `http:*` row is OK; if an expected code differs, set `MON_ENDPOINTS` in the config and record why), one
   test email, then the timer is enabled and one run starts.
5. Verify: `systemctl list-timers aramo-health-probe.timer`, `sudo cat /var/lib/aramo-monitoring/last-status.tsv`,
   and in AWS: `aws lambda invoke --function-name aramo-prod-watchdog /dev/stdout` shows `"failing": []`.
6. After the M-A8 backup timer is enabled (`RUNBOOK-backups.md` §5): set `MON_BACKUP_REQUIRED=1`.

Remove: `sudo deploy/monitoring/install.sh --uninstall` (state and config kept).

## 4. Responding to an alert

General: `ssh` with the designated key, then `sudo cat /var/lib/aramo-monitoring/last-status.tsv` (the
current result of every check) and `journalctl -u aramo-health-probe.service -n 50`. Re-run by hand with
`sudo sh -c 'set -a; . /etc/aramo/monitoring.conf; set +a; /opt/aramo/deploy/monitoring/aramo-health-probe.sh --dry-run'`.
For a confirmed production incident follow [incident-response-and-rollback.md](incident-response-and-rollback.md).

| Check | First look | Then |
|---|---|---|
| `probe-heartbeat` (watchdog) | Is the box up? `url:*` failing too ⇒ box or network down → Lightsail console, [incident-response-and-rollback.md](incident-response-and-rollback.md). URLs fine ⇒ probe stopped: `systemctl status aramo-health-probe.timer`, `journalctl -u aramo-health-probe.service` (exit 3 = AWS publish failing: key revoked/rotated, clock skew) | Fix, then `sudo systemctl start aramo-health-probe.service` |
| `url:*` / `http:*` | `docker ps --format 'table {{.Names}}\t{{.Status}}'`; `docker logs --tail 60 <container>` | Container down or crash-looping → incident runbook. nginx up but 502 → upstream container; remember the nginx ⊥ sign-service coupling (`RELEASE-box.md` HARD STOPS) |
| `container:<name>` | `docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}' <name>`; `docker logs --tail 100 <name>` | `aramo-prod-sign` restarting with "sign-service refuses to start" or "KMS evidence signing key refused" → [kms-and-custody-incidents.md](kms-and-custody-incidents.md) |
| `disk:*` | `df -h`; `sudo du -xh --max-depth=1 /var/lib/docker | sort -h | tail`; `docker system df` | Old images: `docker image prune` removes only dangling images; **never** remove the `:rollback-*` / SHA-pinned rollback-floor images or volumes. Old dumps: dispositions per `RUNBOOK-backups.md` §10 only |
| `memory` | `free -m`; `docker stats --no-stream` | A build (`deploy/build-images.sh`) on the 4 GB box explains a transient dip; otherwise find the container growing |
| `tls:<host>` | `docker logs --tail 100 aramo-prod-certbot` (renew loop every 12 h, DNS-01 via Route 53, `docker-compose.prod.yml` certbot service) | Renewal failing ⇒ the certbot IAM principal (`CERTBOT_AWS_*`) or Route 53. nginx reloads every 6 h; a renewed but unserved cert ⇒ `docker exec aramo-prod-nginx nginx -s reload` |
| `nginx:5xx` | `docker logs --since 15m aramo-prod-nginx 2>/dev/null | awk '$0 ~ /" 5[0-9][0-9] /' | tail -20` (paths are redacted at the source) | Map the path prefix to the service (`aramo.conf.template` locations), read that container's logs |
| `sign:kms`, `sign:custody` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'KMS|sign_artifact_custody'` | [kms-and-custody-incidents.md](kms-and-custody-incidents.md) |
| `sign:purge`, `sign:purge-r13`, `sign:retention` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'sign_purge|purge run|retention'` | [purge-and-party-deletion.md](purge-and-party-deletion.md) §4 |
| `sign:privacy` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'privacy (request|execution)'` | [privacy-requests.md](privacy-requests.md) §5 |
| `sign:webhooks` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'sign_webhook|payment webhook'` | `source=` names the vendor. BAD_SIGNATURE / STALE on every event ⇒ the secret in `.env` differs from the vendor dashboard (rotate both); WRONG_TOPIC ⇒ `SIGN_SMS_AWS_INBOUND_TOPIC_ARN`; `failed` ⇒ the vendor redelivers, read the stack in the same window. Activation guide §3.12–3.18 |
| `sign:messaging` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'sign_messaging|SIGN_(SMS|WHATSAPP)|sms inbound'` | `error=` is the provider's code (AWS: spend limit, throttling, opted out; MSG91: `http_<n>`; Meta: `meta_<code>`). Vendor consoles: AWS End User Messaging, MSG91, Meta WhatsApp Manager. Activation guide §3.12–3.15 |
| `sign:tsa-seal` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'trusted.timestamp|document_seal'` | TSA down or refusing (HTTP status in the pending line; credentials per guide §3.10); seal provider errors per guide §3.11. Completion is never blocked: pending timestamps keep retrying |
| `sign:metering` | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'usage_report|usage report|usage not recorded'` | `reason=` per activation guide §3.21 (PROVIDER_REFUSED: a missing Stripe meter; PROVIDER_RETRIES_EXHAUSTED: Stripe unavailable; live-mode hold: needs its own authorization) |
| `backup` | `sudo ls -lt /var/backups/aramo-r15/heartbeat | head`; `journalctl -u aramo-pg-backup.service -n 80` | `RUNBOOK-backups.md`; the daily freshness Lambda reports the same from S3 |

## 5. Known limits

- The probe reads logs since its previous run; a sign-service recreate between runs loses the old
  container's lines (docker keeps logs per container). Restart checks key on container id, so a recreate
  by a release is not reported as a restart.
- `tls:*` on the box needs `openssl` on the host (`doc/runbooks/singlebox-ops.md` §D uses it; presence on
  the current box not verified). The watchdog checks TLS from outside regardless.
- `docker logs --since` relies on the container's json-file log (`x-aramo-logging`, 10 MB × 5); a burst over
  50 MB within 5 minutes would be partly missed.
- Custody **mismatches** that never produce a log line (silent object loss in S3) are found only by
  `sign:validate-artifact-custody`, run per tenant by an operator ([kms-and-custody-incidents.md](kms-and-custody-incidents.md) §3). A scheduled run is a follow-up.
- No metric dashboards are defined; the metrics are browsable in CloudWatch under `Aramo/Prod`.
