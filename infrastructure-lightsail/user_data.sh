#!/usr/bin/env bash
# Aramo Single-Box — Lightsail user_data (Directive §E): SECRET-FREE OS prep.
#
# Brings the box up "ready to deploy onto": Docker + the compose plugin, Docker
# enabled, and a `deploy` user. Nothing secret-bearing — NO repo clone (needs
# git auth), NO .env, NO deploy, NO seed. Those are runbook steps (they need
# secrets / repo-auth / the §5 sequence). Cloud-init runs this once on first
# boot; it is written to be idempotent-safe so a manual re-run is harmless.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# --- Docker Engine + compose plugin (official Docker apt repo) --------------
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi

# --- Enable Docker so it survives reboots (Directive 3 restart-on-reboot) ---
systemctl enable --now docker

# --- The deploy user --------------------------------------------------------
# A non-root operator account in the docker group. No password, no SSH key
# planted here (key material is a secret — the PO grants access out-of-band).
if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
usermod -aG docker deploy

# A home for the app the runbook will clone/deploy into (owned by deploy).
install -d -o deploy -g deploy /opt/aramo

echo "aramo single-box: OS prep complete (docker $(docker --version), deploy user ready)"
