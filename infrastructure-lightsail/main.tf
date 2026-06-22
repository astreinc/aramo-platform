# The box infrastructure (Directive §C). Recon §A confirmed every resource
# below exists in hashicorp/aws ~> 5.0 (locked 5.100.0). Lightsail rough edges
# are called out inline — chiefly: public_ports is the FULL firewall set
# (managing it takes ownership and closes Lightsail's defaults not listed),
# and the static-IP/Route53 wiring reads the static IP's own address, not the
# instance's public_ip_address (which lags after attachment).

# --- SSH key pair -----------------------------------------------------------
# Import the PO's PUBLIC key. With public_key set, Lightsail does not generate
# a private key, so none is written to state (cf. the §D state-secret rule).
resource "aws_lightsail_key_pair" "this" {
  name       = var.key_pair_name
  public_key = var.ssh_public_key
}

# --- The instance -----------------------------------------------------------
resource "aws_lightsail_instance" "this" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = aws_lightsail_key_pair.this.name

  # Secret-free OS prep only (Directive §E): Docker + compose plugin + deploy
  # user. No repo clone / .env / deploy / seed (those need secrets + the §5
  # sequence — they are runbook steps).
  user_data = file("${path.module}/user_data.sh")

  tags = {
    Name = var.instance_name
    Role = "single-box-app"
  }
}

# --- Static IP + attachment -------------------------------------------------
resource "aws_lightsail_static_ip" "this" {
  name = "${var.instance_name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "this" {
  static_ip_name = aws_lightsail_static_ip.this.name
  instance_name  = aws_lightsail_instance.this.name
}

# --- Firewall (public ports) ------------------------------------------------
# This resource REPLACES the instance's entire public-port set. Listing 80,
# 443 and a restricted 22 closes Lightsail's default-open 22-to-world. Omitting
# `cidrs` on 80/443 leaves them open to all (0.0.0.0/0 + ::/0). Postgres/Redis
# are deliberately absent — they are container-internal and never exposed.
resource "aws_lightsail_instance_public_ports" "this" {
  instance_name = aws_lightsail_instance.this.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }

  # SSH restricted to the PO's source CIDR (var-driven, default-deny-wide).
  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = [var.ssh_source_cidr]
  }
}

# --- DNS --------------------------------------------------------------------
# Zone lookup (recon §A.4: aramo.ai is a public zone in THIS account). The A
# record targets the STATIC IP's address — not aws_lightsail_instance.public_ip
# (which can lag the static-IP attachment).
data "aws_route53_zone" "this" {
  name         = "${var.dns_zone_name}."
  private_zone = false
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.app_fqdn
  type    = "A"
  ttl     = var.dns_record_ttl
  records = [aws_lightsail_static_ip.this.ip_address]
}

# --- Optional scoped S3-backup IAM (Directive §D) ---------------------------
# User + narrow policy only. NO aws_iam_access_key here: an access key's secret
# would be persisted in Terraform state. Generate the key out-of-band after
# apply (README §Backup IAM). Gated off by default.
resource "aws_iam_user" "backup" {
  count = var.create_backup_iam_user ? 1 : 0
  name  = var.backup_iam_user_name
}

resource "aws_iam_user_policy" "backup" {
  count = var.create_backup_iam_user ? 1 : 0
  name  = "s3-backup-putobject-only"
  user  = aws_iam_user.backup[0].name

  # s3:PutObject on <bucket>/<prefix>/* and nothing else — the one legitimate
  # AWS action the box performs. No ListBucket / DeleteObject (retention is a
  # bucket lifecycle rule managed out-of-band, per the ops runbook).
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BackupPutOnly"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "arn:aws:s3:::${var.backup_bucket}/${var.backup_prefix}/*"
      }
    ]
  })
}
