# Compose apps

An app of type **COMPOSE** is a container stack the node brings up from the
repository's own compose file. It has no systemd unit — the stack is the
process — and Caddy reaches it the same way it reaches every other app: through
a loopback port.

The runtime is **rootless Podman**, so an organization's containers run as
`cb-<slug>`, inside its home, counted against its disk quota. There is no
Docker daemon on a Larika node.

## What a node needs

Set the node's **container runtime** to Podman (Servers → edit) and run **Set
up** again. That passes `WITH_PODMAN=1` to `install.sh`, which installs podman,
`uidmap`, `slirp4netns`, `fuse-overlayfs` and Compose v2, and writes
`/usr/local/bin/cb-compose` — Compose v2 pointed at the calling user's own
Podman socket. Everything the panel runs goes through `cb-compose`.

**Ubuntu 24.04 or newer.** 22.04 ships podman 3.4, whose compose support fails
in ways that read as bugs in the app. Setup refuses it.

Creating a compose app on a node with no container runtime is refused at
create time, not at deploy time.

## What an app needs

Four fields, on the app's Settings tab:

| Field | Default | What it is |
|---|---|---|
| Compose files | `docker-compose.yml` | In `-f` order; a later file overrides an earlier one. Relative to the app's folder |
| Env files | `.env` | Where the app's environment variables are written on every deploy |
| Service | — | The service that serves traffic, and the one `exec` runs in by default |
| Container port | — | The port that service listens on **inside** the stack |

Service and container port go together. With both set, the deploy writes a
`docker-compose.override.larika.yml` that republishes that port on
`127.0.0.1:<allocated>`, and points the app's domain at it — and moves every
other port the stack publishes to loopback at its own host port (read from
`compose config`). With either empty, the stack keeps whatever its own files
publish and the panel routes nothing.

The override uses `ports: !override`, because compose *merges* a later file's
ports into the earlier list rather than replacing it. That needs Compose
2.24.4 or newer on the node.

Republishing is not cosmetic: compose files name fixed host ports (5000, 8080,
3306), which collide between two stacks on one node, and a published database
port would otherwise be open on every interface.

## How a deploy runs

1. `sources/` is synced from git, and a new `releases/<stamp>` is copied from it.
2. The env files and the port override are written into the release. What the
   repository ships in an env file is kept, except for keys the app sets, which win.
3. `current` is switched to the new release.
4. `cb-compose up -d --build` — images are built on the node, by the tenant user.
5. The deploy waits for an answer on the allocated port — up to
   `COMPOSE_HEALTH_TIMEOUT_MS` (10 minutes; a first CKAN start initialises its
   database and search index) — and rolls `current` back if nothing comes.

**The compose project name is `cb-<slug>-<appId>` and never the directory.**
Compose would otherwise name the project after the release directory, which
changes every deploy — a new project, a new empty set of volumes, and the old
ones orphaned. This is the reason a redeploy does not lose a stack's database.

## Volumes are not managed

Named volumes belong to the stack, not to the panel. They are not backed up,
not measured, and not listed anywhere in the UI. A database inside a compose
file is invisible to the Databases page.

`Stop` runs `compose stop`. Deleting the app runs `compose down`, which keeps
volumes; pass `removeVolumes` to the delete call to run `down -v` instead.

## Running commands in a stack

`POST /api/applications/:id/exec` with `{ "argv": ["..."], "service": "..." }`,
or the **Run a command in the stack** box under the app's build settings.
Org admins and above; every call is logged with the command.

Deliberately narrow: a fixed `compose exec <service> <argv>`, argv as a list so
it reaches a real exec rather than a shell, no TTY, no interactive session, no
other podman subcommand.

## Walkthrough: CKAN

The Bappenas install guide for the Satu Data portal, as a Larika app. Its
Docker, nginx, ufw and certbot steps are not needed — the node's Podman,
Caddy and Set up do those.

**By hand, once, on the database server** (not the node — rootless containers
cannot reach the node's own 127.0.0.1): PostgreSQL 13+ with PostGIS, exactly
as the guide's pages 5–8: `listen_addresses`, a `pg_hba.conf` line for the
node's IP, the `ckan` user, the `ckan` and `datastore` databases, the
`datastore_ro` role, and `CREATE EXTENSION postgis; CREATE EXTENSION
postgis_topology;` in `ckan`. The panel's database provisioning creates none of that.

**In the panel:**

1. Node: container runtime Podman, Set up. Ubuntu 24.04+.
2. New app, repository `https://github.com/apteksdi/ckan-walidata`, type
   **Compose stack**.
3. Root directory `compose`. Compose files `docker-compose.yml`. Env files
   `.env, .ckan-env`. Service `ckan`, container port `5000`.
4. Env vars: `POSTGRES_HOST` (the database server's IP), `POSTGRES_PASSWORD`,
   `DATASTORE_READONLY_PASSWORD`, `CKAN_SITE_URL` (the real https URL — CKAN
   builds its links from it), `SECRET_KEY`, `CKAN_SYSADMIN_NAME`,
   `CKAN_SYSADMIN_PASSWORD`, `CKAN_SYSADMIN_EMAIL` (the first sysadmin is
   created from these on start), and `CKAN__PLUGINS` with `resourceauthorizer`
   added to the repository's list if resource ACL is wanted.
5. Deploy. The first build is long (five services from one Dockerfile, solr);
   the first start waits up to ten minutes.
6. Add the hostname. Give CKAN a name of its own (`data.example.go.id`): a
   subdirectory needs `CKAN_ROOT_PATH` baked into the Dockerfile and `who.ini`
   edited, which the upstream repository does not do — fork it first if a
   subdirectory is a must, and bind it at `/data/*` with **strip prefix off**.
7. Post-install, in **Run a command in the stack** (service `ckan`):
   `ckan -c production.ini resourceauthorizer initdb`. More users:
   `ckan -c production.ini user add NAME email=... password=...` — with the
   answers as arguments, since there is no terminal to prompt on — and
   `ckan -c production.ini sysadmin add NAME`.

## Self-check

```
cd backend && npx tsx src/services/composeService.check.ts
```

Covers the decisions that are expensive to get wrong: the project name being
stable across releases, the port override, env-file quoting, `-f` order, and
reading `compose ps`.
