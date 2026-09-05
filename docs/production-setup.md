# Production setup

Single-VPS install of CommitBase: Postgres, the Node backend, the built React
frontend served by Caddy, and per-organization OS isolation for the apps the
platform deploys.

Target: Ubuntu 22.04/24.04 or Debian 12. Commands assume root unless a step
says otherwise.

## Who runs what

Five Linux users are involved. Nothing that serves traffic runs as root.

| User | Created by | Runs | Can reach |
|---|---|---|---|
| `root` | the OS | You, during this guide: package installs, the systemd units, the runner scripts, Caddy config. Never a long-running process of the platform | everything |
| `commitbase` | step 2 | The backend (`commitbase.service`), git clones, dependency installs and builds (`cb-build.slice`) | its own `/opt/commitbase`, every tenant home through the `commitbase` **group**, Postgres over localhost, the Caddy admin API |
| `cb-<slug>` | the panel, one per organization | That org's apps: the systemd units and the PHP-FPM pool | only `/home/cb-<slug>`. Cannot see other tenants, `/opt/commitbase`, the database or the env file |
| `caddy` | the `caddy` package | The reverse proxy, TLS | tenant files and FPM sockets read-only, because you add it to the `commitbase` group in step 7 |
| `postgres` | the `postgresql` package | The database | its own data dir |

How root is used at runtime: the backend runs as `commitbase` and needs root
for exactly two things — creating a tenant user (`cb-provision-org`) and
managing a tenant's systemd unit or build cgroup (`cb-app-unit`). Both are
scripts installed in `/usr/local/bin`, listed by name in
`/etc/sudoers.d/commitbase` as NOPASSWD for the `commitbase` user, and each one
validates its own arguments before doing anything. That file is the whole
privilege boundary of the platform; nothing else may be added to it.

Which shell to use per step:

- Steps 1–3, 7–10: a root shell (`sudo -i`).
- Step 4 (build), 5 (env file), 6 (schema), 13 (upgrade): as `commitbase` —
  `sudo -u commitbase -H bash`. Running these as root leaves root-owned files
  the service cannot write later.
- Never log in as `cb-<slug>`; those users have no password and no shell
  session is expected. `sudo -u cb-<slug> ls ...` is only for the cross-tenant
  check in step 11.

SSH as a normal admin user with sudo, not as root directly, is the usual
hardening and changes nothing below.

---

## 0. What you need first

| | |
|---|---|
| VPS | 4 GB RAM minimum. Every tenant app runs on this box — size for the workload, not for the control plane |
| Domain | one for the panel itself, e.g. `panel.example.com` |
| DNS | an A record for the panel pointing at the VPS, and the tenant domains you plan to host |
| Cloudflare | API token with `Zone:Read` + `DNS:Edit`, if you want automatic DNS for tenant domains |
| Cloudflare R2 | account id + access keys, if you want static sites (optional) |
| SMTP | any host, for invite emails (optional — without it invite links are copied out of the UI) |

Filesystem note: tenant disk quotas (`ORG_DISK_QUOTA`) need the filesystem
holding `/home` mounted with `usrquota`. Without it provisioning prints a
warning and continues — everything works, there is just no per-org disk limit.

- **Fresh VPS**: turn it on now, it is five minutes and risk-free (step 7).
- **VPS already in use**: skip it. Enabling quotas later means editing
  `/etc/fstab` and remounting the filesystem, which in practice is a reboot.
  Do it in a maintenance window when you first host a tenant you do not
  control; until then watch `df -h` and keep the org limit as documentation
  of intent. The value in `ORG_DISK_QUOTA` applies automatically once quotas
  are on and the org is re-provisioned from `/admin`.

---

## 1. System packages

**Run as:** `root` (`sudo -i`).

```bash
apt update
apt install -y curl git build-essential postgresql postgresql-contrib \
               quota quotatool debian-keyring debian-archive-keyring apt-transport-https

# Node: current LTS from NodeSource apt, into /usr/bin. Node 20 reached
# end-of-life in April 2026 — use 24 (or 22, in maintenance until April 2027).
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v && which node          # v24.x  /usr/bin/node

# Caddy — reverse proxy for the panel and for every tenant site
apt install -y caddy

# Optional: only if you will host PHP tenants
apt install -y php8.3-fpm php8.3-cli php8.3-mysql php8.3-xml php8.3-mbstring composer

# Optional: only if tenants ship pnpm / yarn / bun lockfiles
corepack enable
```

One Node from apt for the panel, every build and every tenant app. Nothing in
this guide needs nvm; the platform runs and builds apps with whatever `node`
is on the default PATH, which `/usr/bin` is for systemd units, `systemd-run`
builds and tenant users alike. Moving to a newer LTS later is
`setup_<ver>.x | bash - && apt install nodejs && systemctl restart commitbase`;
tenant apps pick it up on their next deploy or restart.

### Optional: per-app Node versions with nvm

Only if tenants need different Node majors (an old Express app on 18 next to
Next 16 on 24). The deployer already supports it: when the app pins a version
in `.nvmrc`, `.node-version` or an exact `engines.node`, the generated
`build.sh` runs `nvm install <version>` and the unit's `run.sh` selects it.
Both scripts source `/opt/nvm/nvm.sh` explicitly, so a system-wide install
works where a per-user nvm in `~/.bashrc` would not. If `/opt/nvm` does not
exist they silently use the apt Node above, so this can be added at any time.

```bash
export NVM_DIR=/opt/nvm
mkdir -p $NVM_DIR
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash
. $NVM_DIR/nvm.sh
nvm install --lts && nvm alias default lts/*
chmod -R a+rX $NVM_DIR                         # tenants read it
chown -R commitbase:commitbase $NVM_DIR        # after step 2; builds install versions into it
```

Set `NVM_DIR=/opt/nvm` in the backend env (step 5). Apps that pin nothing
keep using the apt Node.

`tar` and `cp` from coreutils are used by the deployer (release copies,
hardlinked `node_modules`); both are already on any Debian/Ubuntu install.

---

## 2. Service user

**Run as:** `root`.

The backend runs as its own unprivileged user. That user's **group** is what
gives it access into each tenant's home later, so the name matters — it must
match `CB_GROUP` in the runner scripts (default `commitbase`).

```bash
groupadd --system commitbase
useradd --system --gid commitbase --create-home --home-dir /opt/commitbase \
        --shell /bin/bash commitbase
```

---

## 3. Database

**Run as:** `root` — the commands switch to `postgres` themselves via `sudo -u postgres`.

```bash
sudo -u postgres psql -c "CREATE USER commitbase WITH PASSWORD 'change-me-now';"
sudo -u postgres psql -c "CREATE DATABASE commitbase OWNER commitbase;"
```

Keep Postgres on localhost. Nothing outside the box needs it.

**Database already exists under another owner** (an earlier install ran as
`postgres` or a dev user): create the role if needed, then hand over the
database and everything inside it. Prisma needs the user to own the tables,
not just have grants on them, or `db push` fails on the next schema change.

```bash
sudo -u postgres psql -c "CREATE USER commitbase WITH PASSWORD 'change-me-now';"   # skip if it exists
sudo -u postgres psql -c "ALTER DATABASE commitbase OWNER TO commitbase;"
sudo -u postgres psql -d commitbase -c "ALTER SCHEMA public OWNER TO commitbase;"
sudo -u postgres psql -d commitbase -c "REASSIGN OWNED BY postgres TO commitbase;"
```

`REASSIGN OWNED` moves every table, sequence, index and type the old owner
created in that database. If the old owner was not `postgres`, use that role
name instead. Check:

```bash
sudo -u postgres psql -d commitbase -c "\dt"      # Owner column must read commitbase on every row
sudo -u postgres psql -c "\l commitbase"          # Owner: commitbase
```

Old rows and data are untouched — this changes ownership only.

---

## 4. Get the code and build

**Run as:** `commitbase` — the first line below switches you into that user. Do not build as root: the service could not overwrite root-owned files on the next upgrade.

```bash
sudo -u commitbase -H bash
cd /opt/commitbase
git clone <your-repo-url> app
cd app

# backend
cd backend
npm ci
npx prisma generate
npm run build          # -> backend/dist

# frontend
cd ../frontend
npm ci
npm run build          # -> frontend/dist, served by Caddy as static files
exit
```

> `ecosystem.config.js` starts the frontend with `yarn dev` — that is the Vite
> dev server and is **development only**. In production Caddy serves
> `frontend/dist` directly; do not run the frontend as a process.

---

## 5. Backend environment

**Run as:** `commitbase` for the file itself (`sudo -u commitbase -H nano /opt/commitbase/app/backend/.env`), so it ends up owned by the right user. `chmod 0600` it afterwards.

Write `/opt/commitbase/app/backend/.env`, owned `commitbase:commitbase`, mode
`0600`. Full reference:

### Required

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://commitbase:pw@localhost:5432/commitbase` | |
| `JWT_SECRET` | `openssl rand -hex 48` | Rotating it logs everyone out |
| `NODE_ENV` | `production` | |
| `PORT` | `3001` | Behind Caddy, never exposed |
| `CORS_ORIGIN` | `https://panel.example.com` | Exact origin of the panel |
| `FRONTEND_URL` | `https://panel.example.com` | OAuth redirects |
| `APP_URL` | `https://panel.example.com` | Turns invite tokens into full links |
| `SERVER_IP` | `203.0.113.10` | Public IP tenant DNS records point at |

### Caddy and app placement

| Variable | Default | Notes |
|---|---|---|
| `CADDY_API_URL` | *(unset)* | `http://127.0.0.1:2019` — without it, tenant sites are never configured |
| `CADDY_SITES_DIR` | `/etc/caddy/sites` | Read by the server-inventory sync |
| `APPS_ROOT_DIR` | `/var/www/html` | Document root guessed for synced sites |
| `APPS_DIR` | `./apps_dir` | Legacy flat app directory — used only for apps with no organization |

### Per-organization OS isolation

| Variable | Default | Notes |
|---|---|---|
| `ORG_OS_ISOLATION` | `false` | Set `true` in production |
| `CB_HOME_ROOT` | `/home` | |
| `ORG_PROVISION_SCRIPT` | `/usr/local/bin/cb-provision-org` | |
| `APP_UNIT_SCRIPT` | `/usr/local/bin/cb-app-unit` | |
| `ORG_DISK_QUOTA` | `20G` | Per organization |
| `ORG_CPU_QUOTA` | `50%` | Per organization; `100%` = one full core |
| `ORG_MEMORY_MAX` | `1G` | Per organization, swap disabled |

These are the defaults every organization gets. A single org can be given
different limits through the admin API or `cb-provision-org` — see
[per-org-os-isolation.md](per-org-os-isolation.md#different-limits-per-organization);
note that the admin UI and `provision:orgs` reset custom values to these
defaults until per-org storage lands.

### Deploys and builds

| Variable | Default | Notes |
|---|---|---|
| `APP_PORT_POOL_START` / `APP_PORT_POOL_END` | `20000` / `29999` | Runtime apps get one port each for life, bound to localhost, proxied by Caddy. Apps must listen on `$PORT` |
| `APP_HEALTH_TIMEOUT_MS` | `60000` | How long a deploy waits for the new release to answer before rolling back |
| `BUILD_MEMORY_MAX` | `2G` | Memory ceiling for one build (`next build` wants 1–2 GB). Builds run in `cb-build.slice`, outside the org slices |
| `BUILD_CPU_WEIGHT` | `50` | CPU and IO weight of builds; 100 is a normal process, so 50 yields to serving apps |
| `BUILD_CONCURRENCY` | `1` | Builds running at once. Raise only with the RAM to back it |
| `PHP_FPM_SOCKET_DIR` | `/run/php` | Where the per-org FPM sockets live |
| `NVM_DIR` | `/opt/nvm` | Only with the optional nvm from step 1. `run.sh` and `build.sh` source it to honour the app's `.nvmrc` / `engines.node`; if the directory is missing they use the apt Node |

### Optional

| Variable | Purpose |
|---|---|
| `JWT_EXPIRES_IN` | Token lifetime, default `7d` |
| `SMTP_URL`, `MAIL_FROM` | Invite email. Unset = the link is only shown in the UI |
| `APP_NAME` | Branding in emails, default `CommitBase` |
| `GITHUB_CLIENT_ID` / `_SECRET` | Git integration |
| `GITLAB_CLIENT_ID` / `_SECRET`, `GITLAB_OAUTH_BASE`, `GITLAB_API_BASE` | Self-hosted GitLab |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_PREFIX` | Static-site hosting on Cloudflare R2 |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_ROOT_DIR` | Build-log archive |
| `CRON_ENABLED`, `CRON_DOMAIN_SYNC` | Scheduled domain sync, default `0 3 * * *` |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` | Defaults 15 min / 100 requests |
| `CLOUDFLARE_DNS_TARGET`, `CLOUDFLARE_NS` | Override DNS target and expected nameservers |
| `TZ` | Server timezone for cron |

Cloudflare's **API token and zone id are not env vars** — they live in the
`IntegrationConfig` table and are set from the panel's Integrations page (admin
only) after first login.

### Frontend build-time env

`frontend/.env`, read at build time — changing it means rebuilding:

```
VITE_API_URL=https://panel.example.com/api
VITE_APP_NAME=CommitBase
VITE_APP_TAGLINE=Self-hosted platform
```

---

## 6. Schema and first account

**Run as:** `commitbase` for the Prisma commands (shown with `sudo -u commitbase` inline); the `curl` can run from any user.

```bash
sudo -u commitbase -H bash -c 'cd /opt/commitbase/app/backend && npx prisma db push'
```

Upgrading an install that predates organizations? Also run:

```bash
npm run db:backfill-orgs               # personal org per user, links apps to parent domains
npx tsx src/scripts/checkScope.ts      # hostname-ownership self-check
```

`POST /api/auth/register` works exactly once: it creates the platform admin and
its default organization, then returns 403 forever. Do it now, before the panel
is publicly reachable.

```bash
curl -X POST http://127.0.0.1:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","name":"Admin","password":"<strong-password>"}'
```

Every later account arrives by invite (`/team`) or by admin creation (`/admin`).

---

## 7. Per-organization OS isolation

**Run as:** `root` for the installs, fstab and quota commands. The `provision:orgs` calls at the end run as `commitbase` and are prefixed accordingly.

```bash
cd /opt/commitbase/app
install -m 0755 runner/cb-provision-org.sh /usr/local/bin/cb-provision-org
install -m 0755 runner/cb-app-unit.sh      /usr/local/bin/cb-app-unit
install -m 0440 runner/cb-provision-org.sudoers /etc/sudoers.d/commitbase
install -m 0644 runner/commitbase.logrotate     /etc/logrotate.d/commitbase
visudo -cf /etc/sudoers.d/commitbase        # must print "parsed OK"

# Caddy serves PHP tenants' files and talks to their FPM sockets, both of which
# are group-only. Skip if you will never host PHP.
usermod -aG commitbase caddy && systemctl restart caddy
```

Turn on quotas for the filesystem holding `/home`. Skip on a VPS that is
already serving — see the filesystem note in step 0 — and come back to it in a
maintenance window:

```bash
findmnt -no FSTYPE,SOURCE /home   # or / when /home is not its own mount

# ext4: add usrquota to that entry's options in /etc/fstab, then
mount -o remount /                # or /home
quotacheck -cum /
quotaon -v /

# xfs: the option is uquota and only takes effect at mount time. For a root
# filesystem add rootflags=uquota to GRUB_CMDLINE_LINUX, update-grub, reboot.
```

Expect a reboot to be the honest way to remount `/` on a live box. The full
procedure for a server that is already serving is in
[Appendix A](#appendix-a-enabling-disk-quotas-on-a-live-vps).

Set `ORG_OS_ISOLATION="true"` in the backend env, then provision:

```bash
cd /opt/commitbase/app/backend
sudo -u commitbase -H npm run provision:orgs -- --dry-run
sudo -u commitbase -H npm run provision:orgs
sudo -u commitbase -H npm run check:app-paths
```

New organizations are provisioned automatically when they are created.

---

## 8. Run the backend

**Run as:** `root` — writing a unit file and `systemctl` need it. The service itself runs as `commitbase`, set by `User=` in the unit.

`/etc/systemd/system/commitbase.service`:

```ini
[Unit]
Description=CommitBase control plane
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=commitbase
Group=commitbase
WorkingDirectory=/opt/commitbase/app/backend
EnvironmentFile=/opt/commitbase/app/backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

NoNewPrivileges=false
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`NoNewPrivileges` must stay **false** here: the backend calls `sudo` to provision
tenants, and `NoNewPrivileges=true` blocks setuid, which is how sudo works. This
is the one place the panel is deliberately allowed to escalate, and it is why
the sudoers file lists exactly two commands.

```bash
systemctl daemon-reload
systemctl enable --now commitbase
curl -s http://127.0.0.1:3001/health
```

PM2 (`npm start` at the repo root) is the alternative. It works, but systemd
already supervises every tenant app on this box — one supervisor is enough.

---

## 9. Caddy

**Run as:** `root`.

`/etc/caddy/Caddyfile`:

```caddyfile
{
    # The admin API is how CommitBase adds tenant sites. Keep it on loopback.
    admin 127.0.0.1:2019
    email you@example.com
}

panel.example.com {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }

    handle {
        root * /opt/commitbase/app/frontend/dist
        try_files {path} /index.html
        file_server
    }
}

# Tenant sites are written here by the panel
import /etc/caddy/sites/*.caddy
```

```bash
mkdir -p /etc/caddy/sites
chown caddy:caddy /etc/caddy/sites
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Set `CADDY_API_URL="http://127.0.0.1:2019"` in the backend env and restart it.
Without that variable the panel silently never configures tenant sites.

---

## 10. Firewall

**Run as:** `root`.

```bash
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable
```

Ports 3001 (backend), 5432 (Postgres) and 2019 (Caddy admin) stay on loopback.
Verify with `ss -tlnp | grep -E '3001|5432|2019'` — every line should show
`127.0.0.1`, never `0.0.0.0`.

---

## 11. Verify

**Run as:** any user with sudo, for the `sudo -u cb-other` check. The rest is a browser and `curl`.

1. `https://panel.example.com` loads and you can log in as the admin.
2. `curl -s https://panel.example.com/api/health` returns `{"status":"OK"}`.
3. A second `POST /api/auth/register` returns 403.
4. Create an organization in `/admin` — then `id cb-<slug>` resolves and
   `/home/cb-<slug>` exists with mode `drwxrws---`.
5. Assign a domain to it, deploy a Node app, then check
   `systemctl status cb-<slug>-<appId>.service`, `systemctl status cb-<slug>.slice`
   and `ls -la /home/cb-<slug>/apps/<appId>` — `current` must be a symlink into
   `releases/`, and `logs/deploy.log` must end with *DEPLOYMENT COMPLETED*.
   Click **Redeploy** while it runs: the site must keep answering throughout.
   For PHP, `curl -I https://<tenant-domain>` must come back from PHP-FPM
   (`X-Powered-By` or a Laravel session cookie).
6. The cross-tenant check, the one that actually matters:
   `sudo -u cb-other ls /home/cb-<slug>` must fail with *Permission denied*.

The IDOR sweep in [multi-user-domain-access.md](multi-user-domain-access.md) §10
is worth running once with two client accounts before real customers arrive.

---

## 12. Backups

**Run as:** `root` — reading every tenant home needs it.

```bash
# database
sudo -u postgres pg_dump commitbase | gzip > /var/backups/commitbase-$(date +%F).sql.gz

# tenant files and app sources
tar czf /var/backups/homes-$(date +%F).tar.gz /home/cb-*
```

Back up `backend/.env` separately and treat it as a secret. `GitAccount.accessToken`
and `Application.envVars` are stored **unencrypted**, so a database dump is
equivalent to every tenant's repo credentials — encrypt the backups at rest.

---

## 13. Upgrades

**Run as:** `root`, which then drops to `commitbase` for the build (the block does this itself).

```bash
sudo -u commitbase -H bash -c '
  cd /opt/commitbase/app && git pull &&
  cd backend && npm ci && npx prisma generate && npx prisma db push && npm run build &&
  cd ../frontend && npm ci && npm run build'
systemctl restart commitbase

# The runner scripts are not picked up by git pull — reinstall them every upgrade.
cd /opt/commitbase/app
install -m 0755 runner/cb-provision-org.sh /usr/local/bin/cb-provision-org
install -m 0755 runner/cb-app-unit.sh      /usr/local/bin/cb-app-unit
```

Apps deployed before the release layout existed keep running from `sources/`
until their next deploy, which moves them to `releases/` + `current`.

Tenant apps keep running across a control-plane restart — their systemd units
are independent of the backend process.

---

## 14. Troubleshooting

**Run as:** `root` for `journalctl` and unit status.

| Symptom | Cause |
|---|---|
| Org creation returns *Could not provision isolated OS user* | sudoers not installed, group `commitbase` missing, or the scripts are not in `/usr/local/bin`. Check `journalctl -u commitbase` |
| Tenant sites get no TLS, or never appear | `CADDY_API_URL` unset, or the admin endpoint is not on `127.0.0.1:2019` |
| `warning: quota not applied` during provisioning | `/home` is not mounted with `usrquota`, or `quotaon` was never run |
| App deploys but will not start | `journalctl -u cb-<slug>-<appId>` and `/home/cb-<slug>/apps/<appId>/logs/error.log` |
| Deploy fails with *Nothing answered on port N* | The app is not listening on `$PORT`. Next: `next start -p $PORT`; Express: `app.listen(process.env.PORT)`. Or set the port the app hardcodes in its settings. The previous release was put back |
| Build dies with *Killed* / exit 137 | Hit `BUILD_MEMORY_MAX`. Raise it, or add `NODE_OPTIONS=--max-old-space-size=1536` to the app env |
| Build log says *nvm: could not install node X* | Optional nvm only: no network from the build, or `/opt/nvm` is not writable by `commitbase` (`chown -R commitbase:commitbase /opt/nvm`). The build continued on the apt Node |
| Unit fails with *node: not found* | `apt install nodejs` never ran, or the app's `.nvmrc` pins a version and optional nvm is half set up (`/opt/nvm` present but unreadable by tenants — `chmod -R a+rX /opt/nvm`) |
| *A deployment is already in progress* (409) | One deploy per app at a time; another is running or queued behind `BUILD_CONCURRENCY` |
| PHP deploy fails with *No PHP-FPM pool socket* | PHP-FPM was installed after the org was provisioned. Re-provision the org from `/admin` |
| PHP site returns 502 | `caddy` is not in group `commitbase`, or the FPM pool is not running (`systemctl status php8.3-fpm`) |
| Laravel shows *No application encryption key* | Only if `APP_KEY` was deleted from the app env — it is generated on the first deploy. Redeploy |
| PHP tenant hits *open_basedir restriction* | Expected — that is the isolation boundary. Widen the pool's `open_basedir` only with a reason |
| Everyone logged out after a deploy | `JWT_SECRET` changed, or the env file is not being read |

---

## Known gaps

Real and unfixed. Decide whether they block your launch.

- One PHP version for everything, through the FPM pool version. Node has
  per-app versions through the optional nvm in step 1; PHP does not yet.

- `GitAccount.accessToken` and `Application.envVars` are stored in plaintext.
- Uploaded tenant content is served from the platform's own domains rather than
  a separate content domain, so uploaded HTML/JS shares an origin with the panel.
  See multi-user-domain-access.md §6.

---

## Appendix A: enabling disk quotas on a live VPS

For a box that skipped quotas at install time. Budget 15 minutes plus one
reboot; tenant apps are down for the reboot only (systemd brings them back).

### A.1 Find out what you have

```bash
findmnt -no FSTYPE,SOURCE,OPTIONS /home
findmnt -no FSTYPE,SOURCE,OPTIONS /
```

If `/home` prints nothing, it lives on `/` — use `/` everywhere below. Note the
filesystem type: `ext4` and `xfs` differ in step A.3.

```bash
apt install -y quota
```

### A.2 Back up first

```bash
sudo -u postgres pg_dump commitbase | gzip > /var/backups/commitbase-pre-quota.sql.gz
cp /etc/fstab /etc/fstab.pre-quota
```

Nothing below touches data, but `fstab` mistakes make a box unbootable, and a
copy costs nothing.

### A.3 Add the mount option

**ext4**

```bash
# find the line for the mount point (/ or /home) and add usrquota to its options
nano /etc/fstab
#   before: UUID=...  /  ext4  errors=remount-ro          0 1
#   after : UUID=...  /  ext4  errors=remount-ro,usrquota 0 1
```

Validate before rebooting — a typo here is the one thing that can hurt:

```bash
findmnt --verify --verbose
mount -o remount /        # for /home: mount -o remount /home
findmnt -no OPTIONS / | tr ',' ' ' | grep -qw usrquota && echo "remount applied"
```

If the remount reports *busy* or the option does not show up, skip to A.4 —
the reboot applies it.

**xfs**

The option is `uquota`, it cannot be added by remount, and for the root
filesystem it must come from the kernel command line:

```bash
# /home on its own xfs partition: add uquota to its fstab options, reboot.
# / on xfs:
# append rootflags=uquota inside the quotes of GRUB_CMDLINE_LINUX="..."
nano /etc/default/grub
update-grub
```

### A.4 Reboot in a maintenance window

```bash
systemctl stop commitbase       # no deploys mid-reboot
reboot
```

After it comes back:

```bash
findmnt -no OPTIONS / | tr ',' ' ' | grep -Eqw 'usrquota|uquota|usrjquota=[^ ]+' && echo "quota option active"
systemctl status commitbase caddy
systemctl list-units 'cb-*' --no-pager   # tenant units back up
```

### A.5 Build the quota index and turn it on (ext4 only)

```bash
quotacheck -cum /               # scans the filesystem once; minutes on a big disk
quotaon -v /
repquota -s /                   # every user with usage; cb-* users should be listed
```

xfs needs neither command — quotas are live as soon as the mount option is.

### A.6 Apply the limits to existing organizations

Provisioning is idempotent and now finds quota support:

```bash
cd /opt/commitbase/app/backend
sudo -u commitbase -H npm run provision:orgs
```

No *warning: quota not applied* in the output means it took. Verify one org:

```bash
repquota -s / | grep cb-
quota -s -u cb-<slug>
```

The limit is whatever `ORG_DISK_QUOTA` was at provisioning time (default 20G).
Change the env var and re-run `provision:orgs` to resize all orgs, or use
**Re-provision** on one org in `/admin`.

### A.7 What a tenant sees at the limit

Writes fail with *Disk quota exceeded* (`EDQUOT`). For a Node app that is an
uncaught exception in whatever wrote the file, and the unit restarts in a loop;
for PHP it is a 500 from the FPM pool. `logs/error.log` of the app names the
error. Raise the org's quota or clean `releases/` and `shared/` under
`/home/cb-<slug>/apps/`.

### A.8 Undo

```bash
quotaoff -v /
cp /etc/fstab.pre-quota /etc/fstab       # or just remove the option
# xfs root: remove rootflags=uquota from /etc/default/grub, update-grub
reboot
```

The `aquota.user` file in the filesystem root is harmless and can be deleted
once quotas are off.
