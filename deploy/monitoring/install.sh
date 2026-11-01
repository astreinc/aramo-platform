#!/usr/bin/env bash
# Install (or remove) the Aramo box health probe. Run ON THE BOX as root, from the repo
# checkout at /opt/aramo, only after infrastructure-monitoring/ has been applied from the
# Mac and the publisher access key exists. Procedure: doc/runbooks/sign/monitoring-and-alerts.md §3.
#
#   sudo deploy/monitoring/install.sh               preflight, dry run, install + start the timer
#   sudo deploy/monitoring/install.sh --test-alert  same, then send one test email via SNS
#   sudo deploy/monitoring/install.sh --uninstall   stop + remove the units (state is kept)
#
# It never writes secrets: when /etc/aramo/monitoring.conf is missing it copies the
# example (placeholders only, 0600) and stops so the operator fills it in.
# Exit: 0 ok; 2 not root / missing tool; 4 config missing, unfilled or not 0600.
set -euo pipefail

ARAMO_DIR="${ARAMO_DIR:-/opt/aramo}"
CONF="${MON_CONF:-/etc/aramo/monitoring.conf}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
PROBE="$ARAMO_DIR/deploy/monitoring/aramo-health-probe.sh"

say() { printf '[monitoring-install] %s\n' "$*"; }
die() { printf '[monitoring-install] FATAL: %s\n' "$1" >&2; exit "${2:-2}"; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -x "$PROBE" ] || die "probe not found or not executable: $PROBE"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now aramo-health-probe.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/aramo-health-probe.service" "$UNIT_DIR/aramo-health-probe.timer"
  systemctl daemon-reload
  say "removed the units; /var/lib/aramo-monitoring and $CONF are kept"
  exit 0
fi

for tool in docker curl systemctl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done
command -v openssl >/dev/null 2>&1 || say "WARN openssl not found: the on-box TLS check will report FAIL (install: apt-get install -y openssl)"
command -v flock >/dev/null 2>&1 || say "WARN flock not found: overlapping runs are not prevented (util-linux)"
if ! command -v aws >/dev/null 2>&1; then
  say "aws CLI not on the host: the probe runs it in docker (\${MON_AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}); pulling once"
  docker pull "${MON_AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}" >/dev/null
fi

if [ ! -f "$CONF" ]; then
  install -d -m 0755 "$(dirname "$CONF")"
  install -m 0600 -o root -g root "$ARAMO_DIR/deploy/monitoring/monitoring.conf.example" "$CONF"
  die "created $CONF from the example: fill in MON_SNS_TOPIC_ARN and the publisher key, then re-run" 4
fi
perm="$(stat -c '%a %U' "$CONF")"
[ "$perm" = "600 root" ] || die "$CONF must be root-owned 0600 (is: $perm)" 4
if grep -Eq '^[A-Z_]+=.*<' "$CONF"; then
  die "$CONF still holds <placeholders>" 4
fi

set -a
# shellcheck disable=SC1090
. "$CONF"
set +a

say "dry run (no AWS call, no state):"
"$PROBE" --dry-run || die "dry run failed"

if [ "${1:-}" = "--test-alert" ]; then
  say "sending one test email to the topic"
  if command -v aws >/dev/null 2>&1; then
    aws sns publish --topic-arn "$MON_SNS_TOPIC_ARN" --subject "[Aramo ${MON_HOST_LABEL:-astre-prod}] monitoring test" \
      --message "Test alert from deploy/monitoring/install.sh. No action needed." >/dev/null
  else
    docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION "${MON_AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}" \
      sns publish --topic-arn "$MON_SNS_TOPIC_ARN" --subject "[Aramo ${MON_HOST_LABEL:-astre-prod}] monitoring test" \
      --message "Test alert from deploy/monitoring/install.sh. No action needed." >/dev/null
  fi
fi

install -m 0644 "$ARAMO_DIR/deploy/systemd/aramo-health-probe.service" "$UNIT_DIR/aramo-health-probe.service"
install -m 0644 "$ARAMO_DIR/deploy/systemd/aramo-health-probe.timer" "$UNIT_DIR/aramo-health-probe.timer"
systemctl daemon-reload
systemctl enable --now aramo-health-probe.timer
systemctl start aramo-health-probe.service || say "WARN first run exited non-zero: journalctl -u aramo-health-probe.service"
systemctl list-timers aramo-health-probe.timer --no-pager
say "installed. Last results: /var/lib/aramo-monitoring/last-status.tsv"
