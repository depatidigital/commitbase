#!/bin/bash
# Larika node installer. Ubuntu 22.04/24.04 or Debian 12, run as root.
#
# A node is a box that runs tenant apps. It holds no state of its own: no
# backend, no database, no checkout of this repo. The panel reaches it over SSH
# and does everything else from there (provisioning, deploys, Caddy routes).
#
# Normally the panel runs this for you: Servers page -> Set up, which sends this
# file's text over SSH and runs it as root (serverSetupService). By hand:
#
#   sudo PANEL_SSH_PUBKEY='ssh-ed25519 AAAA... commitbase-panel' ./install.sh
#
# The panel's own box is a node too: run it there with the panel's key
# (/opt/commitbase/.ssh/id_ed25519.pub). The panel itself is set up by hand —
# docs/production-setup.md.
#
# Idempotent: re-running upgrades packages and re-applies the config it owns.
#
# Knobs (env vars):
#   PANEL_SSH_PUBKEY  required   the panel's public key. Authorizes the control
#                     plane to log in as SSH_USER on this box.
#   SSH_USER        larika   the user the control plane logs in as. Gets full
#                   passwordless root: the runner scripts arrive as text over
#                   SSH and run as root, nothing is installed for them.
#   ACME_EMAIL      Let's Encrypt contact; unset = Caddy registers without one
#   NODE_MAJOR      24
#   WITH_PHP=1      also install PHP-FPM + composer for PHP tenants
#   WITH_NVM=1      also install system-wide nvm in /opt/nvm (per-app Node versions)
#   SERVER_IP       public IP, only printed in the summary; auto-detected when unset
#
# Not done here, on purpose: disk quotas (needs a reboot on a live box — see
# docs/production-setup.md Appendix A).

set -euo pipefail

PANEL_SSH_PUBKEY="${PANEL_SSH_PUBKEY:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
NODE_MAJOR="${NODE_MAJOR:-24}"
WITH_PHP="${WITH_PHP:-0}"
WITH_NVM="${WITH_NVM:-0}"
SERVER_IP="${SERVER_IP:-}"

CB_USER=commitbase
CB_GROUP=commitbase
SSH_USER="${SSH_USER:-larika}"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
# Without the key the control plane cannot reach this box, and a node it
# cannot reach is a node that does nothing. Fail now, not at provision time.
[ -n "$PANEL_SSH_PUBKEY" ] || die "PANEL_SSH_PUBKEY is required - the panel's /opt/commitbase/.ssh/id_ed25519.pub"
[[ "$PANEL_SSH_PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9]+)[[:space:]] ]] \
  || die "PANEL_SSH_PUBKEY does not look like an OpenSSH public key"
[[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "SSH_USER looks wrong: $SSH_USER"
command -v apt-get >/dev/null || die "Debian/Ubuntu only"

# ---------------------------------------------------------------- 1. packages
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git + build-essential: tenant apps are cloned and built here, not on the panel.
apt-get install -y -qq sudo curl git build-essential quota debian-keyring debian-archive-keyring \
  apt-transport-https ca-certificates gnupg >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  note "Node $NODE_MAJOR from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
note "node $(node -v) at $(command -v node)"
corepack enable 2>/dev/null || true

if ! command -v caddy >/dev/null; then
  note "Caddy"
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

if [ "$WITH_PHP" = "1" ]; then
  note "PHP-FPM + composer"
  apt-get install -y -qq php-fpm php-cli php-mysql php-pgsql php-xml php-mbstring php-curl php-zip composer >/dev/null
fi

# ------------------------------------------------------------ 2. service user
# Tenant homes are owned cb-<slug>:commitbase, mode 2770. The group is how the
# SSH user and Caddy reach them; the user owns build output. cb-provision-org
# creates both too - done here so the SSH user can join the group right away.
say "Service user $CB_USER"
getent group "$CB_GROUP" >/dev/null || groupadd --system "$CB_GROUP"
id -u "$CB_USER" >/dev/null 2>&1 || useradd --system --gid "$CB_GROUP" --no-create-home --shell /usr/sbin/nologin "$CB_USER"

if [ "$WITH_NVM" = "1" ] && [ ! -s /opt/nvm/nvm.sh ]; then
  note "system-wide nvm in /opt/nvm"
  export NVM_DIR=/opt/nvm; mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash >/dev/null
  chmod -R a+rX "$NVM_DIR"; chown -R "$CB_USER:$CB_GROUP" "$NVM_DIR"
fi

# --------------------------------------------------------------- 3. ssh access
say "SSH access for the control plane"
if ! id -u "$SSH_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups "$CB_GROUP" "$SSH_USER"
  note "created SSH user $SSH_USER"
else
  usermod -aG "$CB_GROUP" "$SSH_USER"
fi
SSH_HOME="$(getent passwd "$SSH_USER" | cut -d: -f6)"
SSH_DIR="$SSH_HOME/.ssh"
install -d -m 0700 -o "$SSH_USER" -g "$(id -gn "$SSH_USER")" "$SSH_DIR"

AUTH_KEYS="$SSH_DIR/authorized_keys"
touch "$AUTH_KEYS"
# Match on the key body, not the whole line: re-running with a different
# comment must not append a second copy of the same key.
KEY_BODY="$(printf '%s' "$PANEL_SSH_PUBKEY" | awk '{print $2}')"
if [ -n "$KEY_BODY" ] && grep -qF "$KEY_BODY" "$AUTH_KEYS"; then
  note "panel key already authorized"
else
  printf '%s\n' "$PANEL_SSH_PUBKEY" >> "$AUTH_KEYS"
  note "authorized the panel key"
fi
chown -R "$SSH_USER:$(id -gn "$SSH_USER")" "$SSH_DIR"
chmod 0600 "$AUTH_KEYS"

# A box with no sshd is unreachable in exactly the way that is hardest to
# diagnose from the panel, so say so here rather than at provision time.
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 ||
  note "WARNING: could not start sshd - the control plane will not be able to reach this box"

# ------------------------------------------------------ 4. sudoers, logrotate
# Inlined, not copied from runner/: this script arrives over SSH as text, so
# there is no checkout on the box to copy from. Keep in step with
# runner/commitbase.sudoers and runner/commitbase.logrotate.
say "Sudoers, logrotate"
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<EOF
# Written by install.sh. The panel runs its runner scripts by sending their text
# over SSH (sudo -n bash -c <script> ...), so the SSH user needs full
# passwordless root. A panel compromise is therefore root on every node.
$SSH_USER ALL=(root) NOPASSWD: ALL
Defaults:$SSH_USER !requiretty
EOF
visudo -cf "$SUDOERS_TMP" >/dev/null || { rm -f "$SUDOERS_TMP"; die "generated sudoers file did not validate"; }
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/commitbase
rm -f "$SUDOERS_TMP"

cat > /etc/logrotate.d/commitbase <<'EOF'
# Written by install.sh.
# App stdout/stderr are appended by systemd; copytruncate keeps the open fd valid.
/home/cb-*/apps/*/logs/out.log /home/cb-*/apps/*/logs/error.log /home/cb-*/logs/php-error.log {
    daily
    rotate 7
    maxsize 50M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
EOF
chmod 0644 /etc/logrotate.d/commitbase

# Left over from when the scripts were installed; a stale copy would only mislead.
rm -f /usr/local/bin/cb-provision-org /usr/local/bin/cb-app-unit
# Caddy serves PHP tenants' files and FPM sockets, both group-only.
usermod -aG "$CB_GROUP" caddy

if findmnt -no OPTIONS "$(findmnt -T /home -no TARGET)" | tr ',' ' ' | grep -qwE 'usrquota|uquota'; then
  note "disk quotas: mount option present"
else
  note "disk quotas: not enabled (no usrquota mount option) — apps work, no per-org disk limit. See docs Appendix A."
fi

# ------------------------------------------------------------------ 5. caddy
# The Caddyfile is only the boot config: the admin API on loopback. Tenant
# sites never touch it - the panel pushes them through the admin API over SSH
# and they live in Caddy's memory. A reload re-reads this file and drops them,
# so Caddy is only reloaded when the file actually changed.
say "Caddy"
CADDYFILE=/etc/caddy/Caddyfile
if [ -f "$CADDYFILE" ] && grep -qE '^\s*admin\s+(127\.0\.0\.1|localhost):2019' "$CADDYFILE"; then
  note "$CADDYFILE already has the admin API on loopback - left untouched"
  CADDY_CHANGED=0
else
  [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  cat > "$CADDYFILE" <<EOF
{
    # Reached by the control plane over the SSH connection, never from the
    # public internet. Keep it on loopback. Tenant sites arrive through it.
    admin 127.0.0.1:2019
$( [ -n "$ACME_EMAIL" ] && echo "    email $ACME_EMAIL" )
}
EOF
  CADDY_CHANGED=1
fi
caddy validate --config "$CADDYFILE" >/dev/null 2>&1 || die "Caddyfile did not validate — restore from $CADDYFILE.bak.* and check"
systemctl enable --now caddy >/dev/null 2>&1
if [ "$CADDY_CHANGED" = 1 ]; then
  # Tenant routes drop here; the panel's caddy-routes watchdog puts them back
  # within five minutes.
  systemctl reload caddy || systemctl restart caddy
fi

# --------------------------------------------------------------- 6. firewall
if command -v ufw >/dev/null; then
  say "Firewall"
  ufw allow OpenSSH >/dev/null
  ufw allow 80,443/tcp >/dev/null
  if ufw status | grep -q '^Status: active'; then
    note "ufw active — rules for 22/80/443 ensured, nothing else changed"
  else
    note "ufw is installed but inactive — NOT enabling it, since other services on this box may need ports open."
    note "when ready: ufw allow <your other ports>; ufw enable"
  fi
fi

# ----------------------------------------------------------------- 7. verify
say "Verify"
# Checked here so a broken box fails at install time rather than on someone's first deploy.
sudo -u "$SSH_USER" sudo -n true \
  || die "$SSH_USER has no passwordless root - check /etc/sudoers.d/commitbase"
note "$SSH_USER has passwordless root for the runner scripts"
systemctl is-active --quiet caddy || note "WARNING: caddy is not running"

say "Done"
cat <<EOF
    This box is a Larika node. It runs no backend and no database.

    Add it in the panel (Servers) with:
      hostname   $(hostname -I | awk '{print $1}')
      ssh user   $SSH_USER
      ssh key    the panel's /opt/commitbase/.ssh/id_ed25519
      public ip  ${SERVER_IP:-$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}

    Verify from the panel box:  sudo -u $CB_USER ssh $SSH_USER@<this-host> sudo -n true
    The runner scripts come from the panel on every call - nothing to upgrade here.
EOF
