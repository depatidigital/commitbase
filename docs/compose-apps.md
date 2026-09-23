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
`127.0.0.1:<allocated>`, and points the app's domain at it. With either empty,
the stack keeps whatever its own files publish and the panel routes nothing.

Republishing is not cosmetic: compose files name fixed host ports (5000, 8080,
3306), which collide between two stacks on one node, and a published database
port would otherwise be open on every interface.

## How a deploy runs

1. `sources/` is synced from git, and a new `releases/<stamp>` is copied from it.
2. The env files and the port override are written into the release. What the
   repository ships in an env file is kept, except for keys the app sets, which win.
3. `current` is switched to the new release.
4. `cb-compose up -d --build` — images are built on the node, by the tenant user.
5. The deploy waits for an answer on the allocated port, and rolls `current`
   back if nothing comes.

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

`POST /api/applications/:id/exec` with `{ "argv": ["..."], "service": "..." }`.
Org admins and above; every call is logged with the command.

Deliberately narrow: a fixed `compose exec <service> <argv>`, argv as a list so
it reaches a real exec rather than a shell, no TTY, no interactive session, no
other podman subcommand.

## Walkthrough: CKAN

The Bappenas install guide for the Satu Data portal, as a Larika app. Its nginx
and certbot steps are not needed — Caddy does both, and takes :80/:443 on the
node.

**By hand, once, on the database box:** PostgreSQL 13 with PostGIS, the `ckan`
and `datastore` databases and the `datastore_ro` role, exactly as the guide has
them. The panel's database provisioning creates none of that.

**In the panel:**

1. Node: container runtime Podman, Set up.
2. New app, repository `https://github.com/apteksdi/ckan-walidata`, type
   **Compose stack** (detection picks it: no `package.json`, and a compose file
   in `compose/`).
3. Root directory `compose`. Compose files `docker-compose.yml`. Env files
   `.env, .ckan-env`. Service `ckan`, container port `5000`.
4. Env vars: `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `DATASTORE_READONLY_PASSWORD`,
   `CKAN_SITE_URL` (the real https URL — CKAN builds its links from it), and
   `CKAN_ROOT_PATH=/data/` if it is served under a subdirectory.
5. Deploy.
6. Add the hostname. For a subdirectory, bind it at path `/data/*` and leave
   **strip prefix off** — CKAN expects to receive `/data/...` intact.
7. Post-install, through exec:
   `{"argv": ["ckan", "-c", "production.ini", "user", "add", "admin"]}` and
   `{"argv": ["ckan", "-c", "production.ini", "resourceauthorizer", "initdb"]}`.

## Self-check

```
cd backend && npx tsx src/services/composeService.check.ts
```

Covers the decisions that are expensive to get wrong: the project name being
stable across releases, the port override, env-file quoting, `-f` order, and
reading `compose ps`.
