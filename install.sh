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
#   PANEL_DOMAIN    required   hostname of the panel, DNS already pointing here
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

PANEL_DOMAIN="${PANEL_DOMAIN:-}"
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
CB_HOME=/opt/commitbase
APP_DIR="$CB_HOME/app"
ENV_FILE="$APP_DIR/backend/.env"
BACKEND_PORT=3001

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -n "$PANEL_DOMAIN" ] || die "PANEL_DOMAIN is required, e.g. PANEL_DOMAIN=panel.example.com"
[[ "$PANEL_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "PANEL_DOMAIN looks wrong: $PANEL_DOMAIN"
command -v apt-get >/dev/null || die "Debian/Ubuntu only"

# ---------------------------------------------------------------- 1. packages
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential postgresql postgresql-contrib \
  quota debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg >/dev/null

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

# ---------------------------------------------------------------- 3. database
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

# -------------------------------------------------------------- 4. code+build
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

# --------------------------------------------------------- 7. isolation bits
say "Runner scripts, sudoers, logrotate"
install -m 0755 "$APP_DIR/runner/cb-provision-org.sh" /usr/local/bin/cb-provision-org
install -m 0755 "$APP_DIR/runner/cb-app-unit.sh"      /usr/local/bin/cb-app-unit
install -m 0440 "$APP_DIR/runner/cb-provision-org.sudoers" /etc/sudoers.d/commitbase
install -m 0644 "$APP_DIR/runner/commitbase.logrotate"     /etc/logrotate.d/commitbase
visudo -cf /etc/sudoers.d/commitbase >/dev/null || die "sudoers file did not validate"
mkdir -p /etc/caddy/sites; chown caddy:caddy /etc/caddy/sites
usermod -aG "$CB_GROUP" caddy

if findmnt -no OPTIONS "$(findmnt -T /home -no TARGET)" | tr ',' ' ' | grep -qwE 'usrquota|uquota'; then
  note "disk quotas: mount option present"
else
  note "disk quotas: not enabled (no usrquota mount option) — apps work, no per-org disk limit. See docs Appendix A."
fi

# ---------------------------------------------------------------- 8. backend
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

# sudo needs setuid; this is the one place the panel escalates (two scripts, see sudoers)
NoNewPrivileges=false
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable commitbase >/dev/null 2>&1
systemctl restart commitbase

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

if [ -f "$CADDYFILE" ] && grep -q "$PANEL_DOMAIN" "$CADDYFILE"; then
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
EOF
