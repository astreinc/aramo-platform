# Runbook — Per-tenant Anthropic key onboarding (TENANT-LLM-1)

**Status:** Canonical operational runbook — v1.0
**Scope:** Onboarding, rotating, and clearing a tenant's own Anthropic API key
under per-tenant Secrets Manager custody. Supersedes the platform-wide
bootstrap model (`doc/runbooks/bootstrap-anthropic-secret.md`) for all
governed LLM features.
**Directive:** `Aramo-TENANT-LLM-1-BYO-Anthropic-Key-Per-Tenant-Secret-Custody-Directive-v0_1-LOCKED`.
**Canonical home:** repo `doc/runbooks/tenant-llm-key-onboarding.md` (tracked).

## Model (what changed)

Each tenant now supplies, owns, and rotates its **own** Anthropic API key.
The key is stored under a tenant-scoped Secrets Manager id and resolved with
the owned `tenant_id` at every governed LLM call site. There is **no**
platform-wide key and **no** cross-tenant / platform fallback: a tenant with
no configured key degrades to a governed "not configured" state, never another
tenant's or a platform key.

- **Secret id:** `aramo/${ARAMO_ENV}/tenant-llm/<tenant_id>/anthropic-api-key`
  (one secret per tenant per environment).
- **Write-only:** the key is written on set/rotate and **never** read back,
  returned by any endpoint, or logged. Only a has-key boolean is readable.
- **Clear = tombstone-not-delete:** clearing writes a tombstone marker (mirrors
  the delegated-token store); status reports the tenant as not configured.
- **Rotation-aware:** every write invalidates the per-tenant cache immediately,
  so a rotated key takes effect on the next call.

## Admin surface (how a tenant onboards)

Tenant admins manage the key from **Settings → Integrations → AI/LLM →
Anthropic** in the ATS console. The panel is write-only: it shows the has-key
status and lets an admin set, rotate, or clear the key; it never displays the
stored value.

The console calls these tenant-scoped endpoints (tenant_id always from the
authenticated session, never the request body):

| Action | Method + path | Scope |
|---|---|---|
| Set / rotate | `PUT /v1/integrations/llm/anthropic/key` (body `{ "api_key": "sk-ant-…" }`) | `integration:write` |
| Clear | `DELETE /v1/integrations/llm/anthropic/key` | `integration:write` |
| Status (has-key) | `GET /v1/integrations/llm/anthropic/status` | `integration:read` |

All three require the `ats` capability entitlement. The response shape is
`{ "provider": "anthropic", "configured": <boolean> }` — the key is never in
any response.

## Prerequisites

- The tenant is entitled to `ats` and the acting admin holds
  `integration:write` (set/rotate/clear) and/or `integration:read` (status).
- An Anthropic API key for the tenant, obtained from that tenant's own
  Anthropic console/organization (not Aramo's).
- Runtime IAM scoped to the tenant-LLM namespace only —
  `aramo/${env}/tenant-llm/*` (read + write), extended in
  `infrastructure-lightsail/main.tf` (`aws_iam_user_policy.api_secrets`). No
  `secretsmanager:*` wildcard.

## Execution — onboard a tenant (console)

1. Sign in to the ATS console as a tenant admin with `integration:write`.
2. Go to **Settings → Integrations → AI/LLM → Anthropic**.
3. Paste the tenant's Anthropic API key and save. The panel writes the key via
   `PUT …/anthropic/key` and re-reads status; on success it shows the tenant as
   configured.
4. Governed LLM features (résumé extraction, etc.) light up for that tenant on
   the next call — the per-tenant cache was invalidated by the write.

### First tenant — Astre (tenant #50)

Onboard Astre through the same console path once the surface is available,
using Astre's own Anthropic key. No secret pre-provisioning step is required —
the write path creates the tenant secret on first save.

## Rotation procedure

1. Obtain a new key from the tenant's Anthropic console.
2. In the panel, save the new key (same **Set / rotate** action). The write
   overwrites the stored value and invalidates the per-tenant cache
   immediately — no process restart needed.
3. Revoke the previous key in the tenant's Anthropic console.

## Verification

- **Status reflects presence:** after saving, `GET …/anthropic/status` returns
  `{ "provider": "anthropic", "configured": true }`.
- **Write-only:** confirm no endpoint (set/rotate/clear/status) ever returns the
  key value; the panel never renders it.
- **Cleared tenant degrades cleanly:** after `DELETE …/anthropic/key`, status is
  `configured: false` and governed LLM features return the "not configured"
  degradation (no fallback, no 500 storm).

## Failure-mode catalog

| Symptom | Likely cause | Remediation |
|---|---|---|
| `configured: false` after saving | Write scope missing or save failed | Confirm the admin holds `integration:write`; re-save; check audit log for the `tenant_llm.key_set` event |
| Governed LLM feature reports "not configured" | Tenant has no key (or it was cleared/tombstoned) | Onboard/re-save the tenant key via the panel |
| Rotated key not taking effect | Stale cache (should not occur — writes invalidate) | Re-save the key; the write invalidates the per-tenant cache |
| `403` on the admin endpoints | Missing `ats` entitlement or `integration:*` scope | Grant the entitlement/scope to the acting admin |
| IAM `AccessDenied` on secret read/write | Runtime IAM not extended to `aramo/${env}/tenant-llm/*` | Extend the `api_secrets` policy to the tenant-LLM namespace (Mac-side TF; never from the box) |

## Notes

- **No platform key.** The governed LLM substrate no longer resolves a
  platform-wide `aramo/${env}/anthropic-api-key`; the tenant-scoped id is the
  only path. The legacy bootstrap runbook/script provisioned the retired
  platform secret and no longer apply to governed extraction.
- **Deploy is out of scope** for TENANT-LLM-1 and is not authorized by its
  directive.
