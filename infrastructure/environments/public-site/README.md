# public-site Terraform environment

Provisions the Aramo public marketing-site host: a Lightsail instance + static
IP (module `../../modules/lightsail-static-site`) and the `aramo.ai` apex / www /
staging **A records** pointing at that IP.

> **This root is the FIRST Terraform managing LIVE Aramo infrastructure.** The
> `aramo.ai` hosted zone is real and pre-existing — it is read as a **data
> source**, never created or owned here. Treat every apply with the care that
> implies.

## Apply is PO-lane

`terraform apply` runs **from the Mac (infra account), never in CI, never on the
box** — the same posture as `environments/{dev,staging,prod}`. CI only runs
`fmt` / `validate` / `lint` / `tfsec` (offline, `-backend=false`).

## Pre-apply checklist (run before the FIRST apply)

1. **Verify the hosted-zone id** — confirm `aramo.ai` resolves to the expected
   zone in the infra account:
   `aws route53 list-hosted-zones-by-name --dns-name aramo.ai`.
2. **Inventory the existing records** — list the current `aramo.ai` record set
   and note **any `*.aramo.ai` wildcard A record** (the plan's explicit
   apex/www/staging A records take precedence over a wildcard for those names,
   but you must know it exists):
   `aws route53 list-resource-record-sets --hosted-zone-id <ZONE_ID>`.
3. **Confirm no apex/www/staging A records already exist** — if `aramo.ai`,
   `www.aramo.ai`, or `staging.aramo.ai` already have A records, Terraform will
   want to overwrite them; reconcile before applying.
4. `terraform init` (S3 backend `aramo-terraform-state-prod`, key
   `public-site/terraform.tfstate`), then `terraform plan`, review, `apply`.

## Serving posture (G0-R3)

Default: the records apply immediately and the apex serves the **holding page**
(nothing answers until the host is up + deployed — acceptable). If the PO
prefers the apex **dark** until launch, gate the three records behind a
`create_dns_records` variable (default false) and drop the holding page — state
that preference before PR-1b Gate-5 completes.

## After apply

The `static_ip` output is the DNS target + the host address for the deploy
runbook at `deploy/public/README.md` (host bring-up, cert issuance, `docker
compose up`, landed-proof assertion).
