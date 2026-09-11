#!/bin/bash
# CommitBase single-VPS installer. Ubuntu 22.04/24.04 or Debian 12, run as root.
#
#   curl -fsSL https://raw.githubusercontent.com/depatidigital/commitbase/main/install.sh \
#     | sudo PANEL_DOMAIN=panel.example.com bash
#
# or from a checkout:  sudo PANEL_DOMAIN=panel.example.com ./install.sh
#
# Idempotent: re-running upgrades the code and re-applies config it owns, and
# leaves alone what you may have edited (backend/.env, an existing Caddyfile
# that already serves the panel, an existing database password).
#
# Knobs (env vars):
#   ROLE            panel|node   panel (default) runs the control plane; node is
#                   a provisioning box that only runs tenant apps. A node gets
#                   a root sudoers grant, logrotate and Caddy, and
#                   nothing else: no backend, no frontend, no Postgres. The
#                   control plane reaches it over SSH.
#   PANEL_DOMAIN    required for ROLE=panel   hostname of the panel, DNS already pointing here
#   PANEL_SSH_PUBKEY  required for ROLE=node  the panel's public key, printed at
#                   the end of a ROLE=panel install. Authorizes the control
#                   plane to run the provisioning scripts on this node.
#   SSH_USER        larika   the user the control plane logs in as, on every
#                   box (this one included). Gets full passwordless root via
#                   runner/commitbase.sudoers (the name is substituted in).
#   ACME_EMAIL      admin@<domain>   Let's Encrypt contact
#   REPO / BRANCH   github.com/depatidigital/commitbase, main
#   NODE_MAJOR      24
#   WITH_PHP=1      also install PHP-FPM + composer for PHP tenants
#   WITH_NVM=1      also install system-wide nvm in /opt/nvm (per-app Node versions)
#   ADMIN_EMAIL / ADMIN_PASSWORD   create the first admin account at the end
#   SERVER_IP       public IP for tenant DNS; auto-detected when unset
#
# Not done here, on purpose: disk quotas (needs a reboot on a live box — see
# docs/production-setup.md Appendix A) and Cloudflare/R2/SMTP settings.

set -euo pipefail

ROLE="${ROLE:-panel}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
PANEL_SSH_PUBKEY="${PANEL_SSH_PUBKEY:-}"
ACME_EMAIL="${ACME_EMAIL:-admin@${PANEL_DOMAIN}}"
REPO="${REPO:-https://github.com/depatidigital/commitbase.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"
WITH_PHP="${WITH_PHP:-0}"
WITH_NVM="${WITH_NVM:-0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SERVER_IP="${SERVER_IP:-}"

CB_USER=commitbase
CB_GROUP=commitbase
SSH_USER="${SSH_USER:-larika}"
CB_HOME=/opt/commitbase
APP_DIR="$CB_HOME/app"
ENV_FILE="$APP_DIR/backend/.env"
BACKEND_PORT=3001

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
case "$ROLE" in
  panel)
    [ -n "$PANEL_DOMAIN" ] || die "PANEL_DOMAIN is required, e.g. PANEL_DOMAIN=panel.example.com"
    [[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "PANEL_DOMAIN looks wrong: $PANEL_DOMAIN"
    ;;
  node)
    # Without the key the control plane cannot reach this box, and a node it
    # cannot reach is a node that does nothing. Fail now, not at provision time.
    [ -n "$PANEL_SSH_PUBKEY" ] || die "ROLE=node needs PANEL_SSH_PUBKEY - the line printed at the end of the panel install"
    [[ "$PANEL_SSH_PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9]+)[[:space:]] ]] \
      || die "PANEL_SSH_PUBKEY does not look like an OpenSSH public key"
    ;;
  *) die "ROLE must be panel or node, got: $ROLE" ;;
esac
command -v apt-get >/dev/null || die "Debian/Ubuntu only"

# ---------------------------------------------------------------- 1. packages
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
BASE_PKGS="curl git build-essential quota debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg"
# The database lives on the panel only. A node holds no state - it can be
# rebuilt and every org re-provisioned from the rows the panel already has.
[ "$ROLE" = panel ] && BASE_PKGS="$BASE_PKGS postgresql postgresql-contrib"
apt-get install -y -qq $BASE_PKGS >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  note "Node $NODE_MAJOR from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
note "node $(node -v) at $(command -v node)"
corepack enable 2>/dev/null || true

if ! command -v caddy >/dev/null; then
  note "Caddy"
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

if [ "$WITH_PHP" = "1" ]; then
  note "PHP-FPM + composer"
  apt-get install -y -qq php-fpm php-cli php-mysql php-pgsql php-xml php-mbstring php-curl php-zip composer >/dev/null
fi

# ------------------------------------------------------------ 2. service user
say "Service user $CB_USER"
getent group "$CB_GROUP" >/dev/null || groupadd --system "$CB_GROUP"
if ! id -u "$CB_USER" >/dev/null 2>&1; then
  useradd --system --gid "$CB_GROUP" --create-home --home-dir "$CB_HOME" --shell /bin/bash "$CB_USER"
fi
mkdir -p "$CB_HOME"; chown "$CB_USER:$CB_GROUP" "$CB_HOME"

if [ "$WITH_NVM" = "1" ] && [ ! -s /opt/nvm/nvm.sh ]; then
  note "system-wide nvm in /opt/nvm"
  export NVM_DIR=/opt/nvm; mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash >/dev/null
  chmod -R a+rX "$NVM_DIR"; chown -R "$CB_USER:$CB_GROUP" "$NVM_DIR"
fi

# --------------------------------------------------------------- 2b. ssh keys
# Provisioning runs over SSH on every box, including this one: the panel's own
# VM is an ordinary Server row, so it authorizes its own key like any node. One
# transport, one code path, nothing special about being local.
say "SSH access for the control plane"
# The key pair belongs to the panel process ($CB_USER); the login it opens is
# $SSH_USER, who is in $CB_GROUP so it can reach tenant homes (mode 2770).
CB_KEY="$CB_HOME/.ssh/id_ed25519"
install -d -m 0700 -o "$CB_USER" -g "$CB_GROUP" "$CB_HOME/.ssh"

if [ "$ROLE" = panel ] && [ ! -f "$CB_KEY" ]; then
  sudo -u "$CB_USER" ssh-keygen -q -t ed25519 -N '' -C 'commitbase-panel' -f "$CB_KEY"
  note "generated $CB_KEY"
fi

if ! id -u "$SSH_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups "$CB_GROUP" "$SSH_USER"
  note "created SSH user $SSH_USER"
else
  usermod -aG "$CB_GROUP" "$SSH_USER"
fi
SSH_HOME="$(getent passwd "$SSH_USER" | cut -d: -f6)"
SSH_DIR="$SSH_HOME/.ssh"
install -d -m 0700 -o "$SSH_USER" -g "$(id -gn "$SSH_USER")" "$SSH_DIR"

# The panel authorizes itself; a node authorizes the panel it was given.
if [ "$ROLE" = panel ]; then AUTHORIZE="$(cat "$CB_KEY.pub")"; else AUTHORIZE="$PANEL_SSH_PUBKEY"; fi

AUTH_KEYS="$SSH_DIR/authorized_keys"
touch "$AUTH_KEYS"
# Match on the key body, not the whole line: re-running with a different
# comment must not append a second copy of the same key.
KEY_BODY="$(printf '%s' "$AUTHORIZE" | awk '{print $2}')"
if [ -n "$KEY_BODY" ] && grep -qF "$KEY_BODY" "$AUTH_KEYS"; then
  note "panel key already authorized"
else
  printf '%s\n' "$AUTHORIZE" >> "$AUTH_KEYS"
  note "authorized the panel key"
fi
chown -R "$SSH_USER:$(id -gn "$SSH_USER")" "$SSH_DIR"
chmod 0600 "$AUTH_KEYS"

# A box with no sshd is unreachable in exactly the way that is hardest to
# diagnose from the panel, so say so here rather than at provision time.
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 ||
  note "WARNING: could not start sshd - the control plane will not be able to reach this box"

# ---------------------------------------------------------------- 3. database
if [ "$ROLE" = panel ]; then
say "Postgres"
systemctl enable --now postgresql >/dev/null
psql_root() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }

DB_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  DB_PASSWORD="$(sed -n 's#^DATABASE_URL="postgresql://commitbase:\([^@]*\)@.*#\1#p' "$ENV_FILE" | head -1)"
fi
if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
fi

if [ "$(psql_root -c "SELECT 1 FROM pg_roles WHERE rolname='$CB_USER'")" = "1" ]; then
  # keep an existing password unless we have none on record
  [ -f "$ENV_FILE" ] || psql_root -c "ALTER USER $CB_USER WITH PASSWORD '$DB_PASSWORD';"
else
  psql_root -c "CREATE USER $CB_USER WITH PASSWORD '$DB_PASSWORD';"
fi

if [ "$(psql_root -c "SELECT 1 FROM pg_database WHERE datname='commitbase'")" = "1" ]; then
  OWNER="$(psql_root -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='commitbase'")"
  if [ "$OWNER" != "$CB_USER" ]; then
    note "database exists, owned by $OWNER — handing it to $CB_USER"
    psql_root -c "ALTER DATABASE commitbase OWNER TO $CB_USER;"
    psql_root -d commitbase -c "ALTER SCHEMA public OWNER TO $CB_USER;"
    psql_root -d commitbase -c "REASSIGN OWNED BY $OWNER TO $CB_USER;"
  fi
else
  psql_root -c "CREATE DATABASE commitbase OWNER $CB_USER;"
fi

fi

# -------------------------------------------------------------- 4. code+build
# Both roles check the code out - a node uses it only as the source of the
# files section 7 installs, and re-running this script upgrades them.
say "Code: $REPO ($BRANCH)"
if [ -e "$APP_DIR" ] && [ ! -d "$APP_DIR/.git" ]; then
  die "$APP_DIR exists but is not a git checkout. Move it away (mv $APP_DIR $APP_DIR.old) and re-run; the installer clones fresh."
fi
if [ -d "$APP_DIR/.git" ]; then
  # A checkout made as root (or any other user) is unusable by the service — take it over.
  chown -R "$CB_USER:$CB_GROUP" "$APP_DIR"
  if [ -n "$(sudo -u "$CB_USER" -H git -C "$APP_DIR" status --porcelain)" ]; then
    die "$APP_DIR has uncommitted local changes — commit, stash or discard them, then re-run (nothing was touched)"
  fi
  sudo -u "$CB_USER" -H git -C "$APP_DIR" fetch -q origin
  sudo -u "$CB_USER" -H git -C "$APP_DIR" checkout -q "$BRANCH"
  sudo -u "$CB_USER" -H git -C "$APP_DIR" pull -q --ff-only origin "$BRANCH"
else
  sudo -u "$CB_USER" -H git clone -q -b "$BRANCH" "$REPO" "$APP_DIR"
fi

# ------------------------------------------------------------------- 5. env
# A node runs no backend, so it has no env file, no build and no schema.
if [ "$ROLE" = panel ]; then
say "Backend env"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
fi
if [ -f "$ENV_FILE" ]; then
  note "$ENV_FILE exists — left untouched"
else
  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -Is). Edit freely; the installer will not overwrite it.
DATABASE_URL="postgresql://commitbase:${DB_PASSWORD}@localhost:5432/commitbase?schema=public"
JWT_SECRET="$(openssl rand -hex 48)"
NODE_ENV="production"
PORT="${BACKEND_PORT}"
CORS_ORIGIN="https://${PANEL_DOMAIN}"
FRONTEND_URL="https://${PANEL_DOMAIN}"
APP_URL="https://${PANEL_DOMAIN}"
SERVER_IP="${SERVER_IP}"

CADDY_API_URL="http://127.0.0.1:2019"
CADDY_SITES_DIR="/etc/caddy/sites"

ORG_OS_ISOLATION="true"
CB_HOME_ROOT="/home"
ORG_DISK_QUOTA="20G"
ORG_CPU_QUOTA="50%"
ORG_MEMORY_MAX="1G"

APP_PORT_POOL_START="20000"
APP_PORT_POOL_END="29999"
BUILD_MEMORY_MAX="2G"
BUILD_CPU_WEIGHT="50"
BUILD_CONCURRENCY="1"
$( [ "$WITH_NVM" = "1" ] && echo 'NVM_DIR="/opt/nvm"' )

# Optional — see docs/production-setup.md step 5:
# SMTP_URL= MAIL_FROM= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET=
# R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY=
EOF
  chown "$CB_USER:$CB_GROUP" "$ENV_FILE"; chmod 0600 "$ENV_FILE"
  note "wrote $ENV_FILE"
fi

FRONTEND_ENV="$APP_DIR/frontend/.env"
if [ ! -f "$FRONTEND_ENV" ] || ! grep -q "VITE_API_URL=https://${PANEL_DOMAIN}/api" "$FRONTEND_ENV"; then
  printf 'VITE_API_URL=https://%s/api\nVITE_APP_NAME=CommitBase\nVITE_APP_TAGLINE=Self-hosted platform\n' "$PANEL_DOMAIN" > "$FRONTEND_ENV"
  chown "$CB_USER:$CB_GROUP" "$FRONTEND_ENV"
fi

say "Build"
sudo -u "$CB_USER" -H bash -c "
  set -e
  cd '$APP_DIR/backend' && npm ci --no-audit --no-fund --silent && npx prisma generate >/dev/null && npm run build --silent
  cd '$APP_DIR/frontend' && npm ci --no-audit --no-fund --silent && npm run build --silent
"

say "Schema"
sudo -u "$CB_USER" -H bash -c "cd '$APP_DIR/backend' && npx prisma db push --skip-generate >/dev/null"
fi

# --------------------------------------------------------- 7. isolation bits
# The runner scripts are not installed: the panel sends them over SSH on every
# call. This box only grants the SSH user passwordless root to run them.
say "Sudoers, logrotate"
# The file names larika; a different SSH_USER is swapped in on the way.
sed "s/\blarika\b/$SSH_USER/g" "$APP_DIR/runner/commitbase.sudoers" > /etc/sudoers.d/commitbase
chown root:root /etc/sudoers.d/commitbase; chmod 0440 /etc/sudoers.d/commitbase
install -m 0644 "$APP_DIR/runner/commitbase.logrotate" /etc/logrotate.d/commitbase
visudo -cf /etc/sudoers.d/commitbase >/dev/null || die "sudoers file did not validate"
# Left over from when the scripts were installed; a stale copy would only mislead.
rm -f /usr/local/bin/cb-provision-org /usr/local/bin/cb-app-unit
mkdir -p /etc/caddy/sites; chown caddy:caddy /etc/caddy/sites
usermod -aG "$CB_GROUP" caddy

if findmnt -no OPTIONS "$(findmnt -T /home -no TARGET)" | tr ',' ' ' | grep -qwE 'usrquota|uquota'; then
  note "disk quotas: mount option present"
else
  note "disk quotas: not enabled (no usrquota mount option) — apps work, no per-org disk limit. See docs Appendix A."
fi

# ---------------------------------------------------------------- 8. backend
if [ "$ROLE" = panel ]; then
say "commitbase.service"
# Something else on the backend port (an old pm2 run, a dev server) would make
# the new unit crash-loop. Refuse rather than fight it.
if ! systemctl is-active --quiet commitbase 2>/dev/null && ss -ltn "( sport = :$BACKEND_PORT )" | grep -q ":$BACKEND_PORT"; then
  ss -ltnp "( sport = :$BACKEND_PORT )" | sed 's/^/    /'
  die "port $BACKEND_PORT is taken by something that is not commitbase.service (pm2? 'pm2 delete all && pm2 unstartup'). Stop it and re-run."
fi
cat > /etc/systemd/system/commitbase.service <<EOF
[Unit]
Description=CommitBase control plane
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$CB_USER
Group=$CB_GROUP
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# sudo needs setuid; the panel escalates to run its runner scripts (see runner/commitbase.sudoers)
NoNewPrivileges=false
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable commitbase >/dev/null 2>&1
systemctl restart commitbase
fi

# ------------------------------------------------------------------ 9. caddy
say "Caddy"
CADDYFILE=/etc/caddy/Caddyfile
PANEL_BLOCK="$PANEL_DOMAIN {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:$BACKEND_PORT
    }

    handle {
        root * $APP_DIR/frontend/dist
        try_files {path} /index.html
        file_server
    }
}"

if [ "$ROLE" = node ]; then
  # A node runs its own Caddy because tenant PHP is served from a local FPM
  # socket and a local docroot - neither can be reverse-proxied from the panel.
  # It gets the admin API and the tenant import, and no panel vhost.
  if [ -f "$CADDYFILE" ] && grep -q '/etc/caddy/sites/\*.caddy' "$CADDYFILE"; then
    note "$CADDYFILE already imports the tenant sites - left untouched"
  else
    [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    cat > "$CADDYFILE" <<EOF
{
    # Reached by the control plane over the SSH connection, never from the
    # public internet. Keep it on loopback.
    admin 127.0.0.1:2019
    email $ACME_EMAIL
}

# Tenant sites are written here by the panel
import /etc/caddy/sites/*.caddy
EOF
  fi
elif [ -f "$CADDYFILE" ] && grep -q "$PANEL_DOMAIN" "$CADDYFILE"; then
  note "$CADDYFILE already serves $PANEL_DOMAIN — left untouched"
elif [ -f "$CADDYFILE" ] && grep -qE '^[^#]*\{' "$CADDYFILE" && ! grep -qE '^\s*(# Caddyfile|:80 \{|:80\{)' "$CADDYFILE"; then
  # A Caddyfile with real sites in it: keep every byte, append ours.
  cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  note "existing sites found — appending the panel block, nothing removed (backup: $CADDYFILE.bak.*)"
  if ! grep -qE '^\s*admin\s' "$CADDYFILE"; then
    note "no explicit admin address; Caddy's default is localhost:2019, which is what CADDY_API_URL expects"
  fi
  {
    printf '
# --- CommitBase panel (added by install.sh) ---
'
    printf '%s
' "$PANEL_BLOCK"
    grep -q '/etc/caddy/sites/\*.caddy' "$CADDYFILE" || printf '
# Tenant sites written by the panel
import /etc/caddy/sites/*.caddy
'
  } >> "$CADDYFILE"
else
  # Package default or empty: replace.
  [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  cat > "$CADDYFILE" <<EOF
{
    # The admin API is how CommitBase adds tenant sites. Keep it on loopback.
    admin 127.0.0.1:2019
    email $ACME_EMAIL
}

$PANEL_BLOCK

# Tenant sites are written here by the panel
import /etc/caddy/sites/*.caddy
EOF
fi
caddy validate --config "$CADDYFILE" >/dev/null || die "Caddyfile did not validate — restore from $CADDYFILE.bak.* and check"
systemctl enable caddy >/dev/null 2>&1
# reload, not restart: existing sites keep serving, no dropped connections
systemctl reload caddy || systemctl restart caddy

# --------------------------------------------------------------- 10. firewall
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

# ----------------------------------------------------------------- 11. verify
say "Verify"
# Both roles: the panel's own box is a node too. Checked here so a broken box
# fails at install time rather than on someone's first deploy.
sudo -u "$SSH_USER" sudo -n true \
  || die "$SSH_USER has no passwordless root - check /etc/sudoers.d/commitbase"
note "$SSH_USER has passwordless root for the runner scripts"

if [ "$ROLE" = node ]; then
  systemctl is-active --quiet caddy || note "WARNING: caddy is not running"

  say "Done"
  cat <<EOF
    This box is a CommitBase node. It runs no backend and no database.

    Add it in the panel with:
      hostname   $(hostname -I | awk '{print $1}')
      ssh user   $SSH_USER
      ssh key    the panel's /opt/commitbase/.ssh/id_ed25519
      public ip  ${SERVER_IP:-$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}
      caddy api  http://127.0.0.1:2019

    Verify from the panel:  sudo -u $CB_USER ssh $SSH_USER@<this-host> sudo -n true
    The runner scripts come from the panel on every call - nothing to upgrade here.
EOF
  exit 0
fi

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 30 ] && die "backend did not answer on :$BACKEND_PORT — journalctl -u commitbase -n 50"
done
note "backend healthy"

if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  CODE="$(curl -s -o /tmp/cb-register.json -w '%{http_code}' -X POST "http://127.0.0.1:$BACKEND_PORT/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"name\":\"Admin\",\"password\":\"$ADMIN_PASSWORD\"}")"
  case "$CODE" in
    200|201) note "admin account created: $ADMIN_EMAIL" ;;
    403)     note "admin already exists — registration is closed, as designed" ;;
    *)       note "register returned $CODE: $(cat /tmp/cb-register.json)" ;;
  esac
  rm -f /tmp/cb-register.json
fi

say "Done"
cat <<EOF
    Panel:        https://$PANEL_DOMAIN   (TLS is issued on first request; DNS must already point here)
    Backend env:  $ENV_FILE
    Logs:         journalctl -u commitbase -f

    Next:
      - First admin: $( [ -n "$ADMIN_EMAIL" ] && echo "log in as $ADMIN_EMAIL" || echo "POST /api/auth/register once (docs step 6) or re-run with ADMIN_EMAIL= ADMIN_PASSWORD=" )
      - Integrations page: Cloudflare token / zone
      - Disk quotas (optional, one reboot): docs/production-setup.md Appendix A
      - Re-run this script any time to upgrade: same command, same knobs

    Seed this VM as the first node (it is an ordinary Server row):
      cd $APP_DIR/backend && sudo -u $CB_USER npm run db:seed-server

    Add another node - on that box, run this same script with:
      ROLE=node PANEL_SSH_PUBKEY='$(cat "$CB_KEY.pub" 2>/dev/null)' ./install.sh
EOF
