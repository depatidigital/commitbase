# Per-organization OS isolation

Every organization gets its own Linux user, home directory, disk quota, cgroup
slice and PHP-FPM pool. One tenant's processes cannot read another tenant's
files, and one tenant cannot eat the whole VPS.

Docker is not used at all — apps run as systemd units.

## What an organization owns

```
/home/cb-<slug>                          cb-<slug>:commitbase  2770
/home/cb-<slug>/apps/<applicationId>/sources               git checkout or upload (input)
/home/cb-<slug>/apps/<applicationId>/releases/<stamp>      copy of sources, installed + built
/home/cb-<slug>/apps/<applicationId>/current -> releases/<stamp>
/home/cb-<slug>/apps/<applicationId>/shared/next-cache     .next/cache shared across releases
/home/cb-<slug>/apps/<applicationId>/logs/{out,error,build,deploy}.log
/home/cb-<slug>/apps/<applicationId>/run.sh          generated per deploy
/etc/systemd/system/cb-<slug>.slice                  CPU + memory ceiling
/etc/systemd/system/cb-<slug>-<applicationId>.service
/etc/php/<ver>/fpm/pool.d/cb-<slug>.conf             open_basedir + disable_functions
```

The home is owned by the tenant user with the backend's group, mode 2770. That
is the boundary: `other` has no bits, so tenant B cannot even traverse into
tenant A's home. The backend keeps access through the group because it has to
build and read logs.

## Install

```bash
sudo install -m 0755 runner/cb-provision-org.sh /usr/local/bin/cb-provision-org
sudo install -m 0755 runner/cb-app-unit.sh      /usr/local/bin/cb-app-unit
sudo install -m 0440 runner/cb-provision-org.sudoers /etc/sudoers.d/commitbase
sudo install -m 0644 runner/commitbase.logrotate     /etc/logrotate.d/commitbase
sudo visudo -cf /etc/sudoers.d/commitbase
```

The sudoers file assumes the backend runs as the user `commitbase` and that a
group of the same name exists. Change both names together if yours differ
(`CB_GROUP` in the scripts' environment).

Disk quotas need the filesystem holding `/home` mounted with `usrquota` and
`quotaon` run against it; without that the scripts warn and continue.

## Enable

```bash
# backend/.env
ORG_OS_ISOLATION="true"
```

Then provision every existing organization and move the app directories out of
the old flat `apps_dir`:

```bash
cd backend
npm run provision:orgs -- --dry-run   # shows what would move
npm run provision:orgs
npm run check:app-paths               # path-layout self-check
```

New organizations are provisioned automatically at `POST /api/organizations` —
the OS user is created before the row, so an org can never exist without a home.

## When provisioning runs

| Trigger | What happens |
|---|---|
| `POST /api/organizations` (an org is created) | The OS user is provisioned **before** the row is written. If provisioning fails the request returns 500 and no organization is created — an org can never exist without a home |
| First-ever registration (`POST /api/auth/register`) | The bootstrap `default` organization is provisioned too, but a failure is logged and ignored so the very first login cannot be locked out. Re-run it from `/admin` |
| `POST /api/admin/organizations/:id/provision` | Manual re-run. This is the **Provision / Re-provision** button on `/admin` → Organizations |
| `npm run provision:orgs` | Bulk run over every organization, plus the move of app directories out of the old flat `apps_dir` |

The script is idempotent, so a re-run is also how you repair file ownership
after a manual edit and how you apply changed resource limits.

## Admin UI

`/admin` has three tabs:

- **Domains** — ownership assignment, as before.
- **Organizations** — every org with its isolation state, and the button that
  triggers provisioning. States: *Provisioned*, *No resource limits* (home
  exists but the cgroup slice is missing), *Not provisioned*, *Disabled*
  (`ORG_OS_ISOLATION` is off — the button is inert and a banner says why).
- **Provisioning log** — every run, newest first, with the script's own output,
  what triggered it (`org-create`, `bootstrap`, `admin`) and who clicked.

Status is read without sudo: the backend stats `/home/cb-<slug>` and
`/etc/systemd/system/cb-<slug>.slice`, so listing the page has no side effects.

Endpoints behind it, all `ADMIN` only:

```
GET  /api/admin/organizations                  # orgs + provisioning state
GET  /api/admin/organizations/:id/provision    # state for one org
POST /api/admin/organizations/:id/provision    # run it; optional { diskQuota, cpuQuota, memoryMax }
GET  /api/admin/provision-logs                 # ?organizationId= to scope
```

Runs are written to the existing `Log` model with
`metadata.scope = "provisioning"` — no new table, and they show up in whatever
log tooling already reads that table.

## Resource limits

Set per install in the backend env, applied per organization:

| Variable | Default | Effect |
|---|---|---|
| `ORG_DISK_QUOTA` | `20G` | `setquota` hard block limit on `/home` |
| `ORG_CPU_QUOTA` | `50%` | `CPUQuota=` on `cb-<slug>.slice` |
| `ORG_MEMORY_MAX` | `1G` | `MemoryMax=` on the slice, swap disabled |

The slice is org-wide, not per app: all of one tenant's apps share the ceiling,
so a tenant cannot buy more CPU by splitting one app into five.

### Different limits per organization

Every limit is per OS user / per slice, so each org can have its own. What
exists today:

| Layer | Per-org values | Notes |
|---|---|---|
| OS (`cb-provision-org`) | yes | Arguments `<slug> <disk> <cpu> <memory>` |
| API | yes | `POST /api/admin/organizations/:id/provision` with `{ diskQuota, cpuQuota, memoryMax }` in the body |
| Admin UI | **no** | The *Re-provision* button sends no body, so it applies the env defaults |
| Database | **no** | Nothing is stored on `Organization`; a later `provision:orgs` run puts every org back on the env defaults |

Until the UI and the columns exist, set a custom limit through the API:

```bash
curl -X POST https://panel.example.com/api/admin/organizations/<orgId>/provision   -H "Authorization: Bearer <admin-token>" -H "Content-Type: application/json"   -d '{"diskQuota":"50G","cpuQuota":"100%","memoryMax":"2G"}'
```

or on the box, which is the same script:

```bash
sudo cb-provision-org acme 50G 100% 2G
```

Formats: disk `20G` / `500M`, CPU `50%` (`200%` = two cores), memory `1G`.
Both paths are idempotent and take effect immediately — the slice is updated
live and quota with `setquota`, no app restart needed.

Keep a note of which orgs have custom values: clicking *Re-provision* in
`/admin` or running `npm run provision:orgs` resets them to the env defaults.
Making the values stick (three nullable columns on `Organization`, read at
provisioning time, editable in the Re-provision dialog) is the pending piece.

## PHP

PHP apps do not get a unit. They are served by the org's own FPM pool over
`/run/php/php<ver>-fpm-cb-<slug>.sock`, with `open_basedir` pinned to the org's
home and the process-spawning functions disabled:

```
exec, system, shell_exec, passthru, popen, proc_open, proc_nice,
proc_terminate, pcntl_exec, dl, symlink, link
```

`symlink` and `link` are on that list deliberately — without them a tenant can
link a file outside `open_basedir` and read it through the link.

A PHP deploy builds a release like a Node app (`composer install`, then the
asset build if there is a `package.json`), writes the platform env vars into
the release's `.env` (Laravel convention; repo keys are kept unless
overridden), hands the tree to the tenant with `cb-app-unit chown`, and points
Caddy at `current/<docroot>` — `public/` for Laravel and Symfony, the root
otherwise — with `*.php` going to the org's FPM socket.

Caddy has to reach both the socket (`0660 cb-<slug>:commitbase`) and the
tenant's files (`2770`), so the `caddy` user must be in the backend's group:

```bash
sudo usermod -aG commitbase caddy && sudo systemctl restart caddy
```

Static sites also get no unit; they are served from R2 through Caddy.

## Security notes

- Nothing from the database is ever interpolated into a shell string on the way
  to a root command. `orgProvisionService` uses `execFile` with an argument
  array, and both scripts revalidate their arguments because a sudoers entry
  cannot constrain them.
- Units run with `NoNewPrivileges=true`, `ProtectSystem=strict`,
  `PrivateTmp=true` and a writable path list of exactly one directory.
- Env vars reach the app through `run.sh`, written with single-quote escaping,
  never through a shell string assembled at run time.

## Rollback

There is no second runtime to fall back to. Set `ORG_OS_ISOLATION="false"` only
to stop provisioning new organizations — running apps keep their units. The OS
users and slices are inert once nothing references them; remove one with
`userdel -r cb-<slug>` plus its slice and pool files.

## Deploy flow for runtime apps (Node, Next.js, …)

1. `sources/` is synced (git) or replaced (upload).
2. The framework is detected from `package.json`, the lockfile and
   `next.config.*` (`backend/src/lib/projectDetect.ts`). Empty build/start
   commands fall back to the detected ones.
3. A new `releases/<stamp>` is copied from `sources/` (without `node_modules`,
   `.next`, `.git`) and installed + built there, with the app's env vars
   present so `NEXT_PUBLIC_*` bakes in. The running release is never touched.
4. `current` is switched to the new release (atomic rename) and the unit
   restarted. The deploy waits for an HTTP answer on `127.0.0.1:$PORT`.
5. No answer within `APP_HEALTH_TIMEOUT_MS` → `current` goes back to the
   previous release, it is restarted, and the deployment is marked FAILED.
6. The last 3 releases are kept; "start release" on `/applications/:id`
   switches `current` to any of them.

Node version: if the app has `.nvmrc`, `.node-version` or `engines.node` with
a concrete version, `build.sh` runs `nvm install` for it and `run.sh` selects
it — both read the system-wide nvm in `NVM_DIR` (`/opt/nvm`). No pin, or no
nvm on the box, means the default `node` on PATH.

Ports come from a pool (`APP_PORT_POOL_START`..`APP_PORT_POOL_END`, default
20000-29999), one per app for life, bound to localhost and proxied by Caddy.
Apps must listen on `$PORT`; the health check is what enforces it.

After pulling this change, reinstall the runner script — the unit's
`WorkingDirectory` changed:

```bash
sudo install -m 0755 runner/cb-app-unit.sh /usr/local/bin/cb-app-unit
```
