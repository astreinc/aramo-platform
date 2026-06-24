# infrastructure-lightsail — the Aramo single-box (go-live #1), as code

A **completely separate Terraform root** that provisions the Astre single-box:
the Lightsail instance, a static IP, the firewall, and the `astre.aramo.ai` DNS
record (plus an optional scoped S3-backup IAM user). This is **go-live #1's
infrastructure** — unlike the platform root in [`../infrastructure/`](../infrastructure/)
(reserved, never applied), **this root is MEANT to be applied** by the PO.

## Separation (the load-bearing constraint)

This root shares **nothing** with the platform `infrastructure/`:

- **Its own state file** — `lightsail/terraform.tfstate` (a different key from the
  platform's `prod/terraform.tfstate`). It reuses the existing state *bucket* and
  lock table, but never the platform's state file. Separate state files =
  separate `apply` blast radii.
- **Its own provider config**, **no shared modules**, **no `terraform_remote_state`
  reads** of the platform. The platform root is not touched by anything here.

## What it provisions (`main.tf`)

| Resource | Purpose |
| --- | --- |
| `aws_lightsail_key_pair` | Imports the PO's **public** SSH key (no private key in state) |
| `aws_lightsail_instance` | The box: `us-east-1a`, `medium_3_0` (2 vCPU / 4 GB), clean `ubuntu_24_04` |
| `aws_lightsail_static_ip` + `_attachment` | A stable public IPv4, attached |
| `aws_lightsail_instance_public_ports` | Firewall: **80 + 443 open**, **22 restricted** to `ssh_source_cidr`. Postgres/Redis never opened |
| `aws_route53_record` | A record `astre.aramo.ai` → the static IP (zone looked up by data source) |
| `aws_iam_user` + `aws_iam_user_policy` | *Optional* — `s3:PutObject`-only backup user (off by default) |

`user_data.sh` is **secret-free OS prep only**: Docker + the compose plugin,
Docker enabled, a `deploy` user, `/opt/aramo`. No repo clone / `.env` / deploy /
seed (those are runbook steps).

## Usage

```bash
cd infrastructure-lightsail
cp terraform.tfvars.example terraform.tfvars   # set ssh_public_key + ssh_source_cidr
terraform init
terraform plan
terraform apply        # creates REAL, billable resources (~$24/mo + IP while detached)
```

Required vars (no defaults): `ssh_public_key`, `ssh_source_cidr`.

## Backup IAM — generating the access key out-of-band (no secret in state)

If `create_backup_iam_user = true`, Terraform creates the user + the narrow
`s3:PutObject` policy **but not an access key** — an `aws_iam_access_key` would
persist its secret in state. Generate the key out-of-band after apply:

```bash
aws iam create-access-key --user-name astre-aramo-backup-putter
# put AccessKeyId / SecretAccessKey into /etc/aramo/backup.conf on the box (chmod 600)
```

This is the credential the Directive-3 backup job uses (see the ops runbook).
S3-side retention is a bucket **lifecycle rule** managed out-of-band, so the box
credential stays `PutObject`-only.

## SES mailer IAM — `ses:SendEmail` grant (PO-console apply)

Email-S1 adds Aramo's transactional mailer (`@aramo/mailer`). The api authenticates
to AWS via the **static access-key creds** in the box's `.env` (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`) — that principal is **managed out-of-band, not a Terraform
resource here** (only the optional backup user is in `main.tf`). So the SES grant is a
**manual/console apply to that principal**, the same category as Cognito + `.env` below.

The least-privilege statement to attach is [`ses-mailer-iam.json`](ses-mailer-iam.json)
— modeled on the `s3:PutObject`-only backup policy shape (`main.tf` §Backup IAM):
`ses:SendEmail` / `ses:SendRawEmail` scoped to the `aramo.ai` verified identity and
**pinned to `support@aramo.ai`** via an `ses:FromAddress` condition (can't send as
anything else). Apply with:

```sh
# attach to the principal whose access key the box's .env carries:
aws iam put-user-policy --user-name <api-principal> \
  --policy-name ses-send-support-only \
  --policy-document file://ses-mailer-iam.json
```

PO console prerequisites (SES side — AWS's clock, start first): verify the `aramo.ai`
domain identity (us-east-1), add the SES-generated DKIM CNAMEs to Route53 zone
`Z036386539U6ZS64ATYDK`, and **file the SES sandbox-exit / production-access request**
(the longest-lead item — until granted, SES sends only to verified addresses).

## Explicitly OUT of this root (the remaining manual / runbook steps)

- **Cognito** — the pool `us-east-1_4fKlnGfaW` was created outside Terraform and
  is **shared** across all the §5 work. Importing it here to add a callback URL
  would make Terraform try to own + drift-correct a shared pool. It stays a
  documented manual/CLI step (the ops runbook's §5 Cognito checklist).
- **`.env` secrets** — never in Terraform/state. Manual on the box, `chmod 600`.
- **The app deploy + seed** — runbook (compose up, the scrubbed Astre seed, the
  §5 login checklist).

See [`../doc/step4-singlebox-lightsail-tf.md`](../doc/step4-singlebox-lightsail-tf.md)
for the full recon report and the manual remainder.
