# SES mail alignment for portal magic-link + notice mail (release blocker:
# SPF/DMARC). Identity aramo.ai pre-exists in SES (verified, prod access
# GRANTED) and is deliberately NOT imported — only the mail-from attribute
# and DNS records are managed here.

resource "aws_sesv2_email_identity_mail_from_attributes" "aramo" {
  email_identity   = "aramo.ai"
  mail_from_domain = "mail.aramo.ai"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "mail.aramo.ai"
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.us-east-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "mail.aramo.ai"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "_dmarc.aramo.ai"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=none; rua=mailto:purush@astreinc.com; adkim=r; aspf=r"]
}
